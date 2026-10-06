import { encodeMediaFrame, decodeMediaFrame, MEDIA_TYPE_AUDIO, CODEC_OPUS } from "@vc/protocol";
import type { ServerMsg } from "@vc/protocol";
import type { Transport, TransportCtx } from "./types";
import { createFeedDetector, createJsDetector, type Detector } from "../audio/detector";
import * as Moq from "@moq/net";

const FRAME_SAMPLES = 960; // 20ms @ 48kHz
const SR = 48000;

// MoQ transport: moq-lite over WebTransport against a real moq-relay.
// Each client publishes broadcast `vc-bench/<room>/<id>` with an "audio" track;
// Opus frames ride as single-frame groups = QUIC datagrams (unreliable).
// Signaling (roster/ping) stays on the contract WS connection; the WS roster
// drives which peer broadcasts we subscribe to.
export class MoqTransport implements Transport {
  name = "moq";
  needsPcm = true;
  private c!: TransportCtx;
  private enc!: AudioEncoder;
  private decs = new Map<string, AudioDecoder>();
  private dets = new Map<string, Detector>();
  private acc = new Float32Array(0);
  private seq = 0;
  private tsUs = 0;
  private counters = { sent: 0, recv: 0, fed: 0, bytes: 0, dgram_rtt_ms: [] as number[] };
  private lastLat = new Map<string, number>();
  private conn?: Moq.Connection.Established;
  private ietf = false;
  private frameSamples = FRAME_SAMPLES;
  private maxAge!: Moq.Time.Milli;
  private track?: Moq.Track.Producer;
  private jsDets = new Map<string, (pcm: Float32Array) => void>();
  private subs = new Set<string>();
  private originRef?: Moq.Origin.Producer;

  private gainTimer?: ReturnType<typeof setInterval>;

  async start(c: TransportCtx): Promise<void> {
    this.c = c;
    this.gainTimer = setInterval(() => {
      for (const [peer, det] of this.dets) det.gain = c.gains?.get(peer) ?? 1;
    }, 250);
    if (!c.media) throw new Error("moq needs a media param");

    // Certificate pinning is OPTIONAL. Chrome rejects a pinned certificate whose
    // validity period exceeds 14 days, so a publicly-trusted (e.g. Let's
    // Encrypt, 90-day) relay certificate must be validated against the system
    // trust store instead — i.e. send no serverCertificateHashes at all.
    // Pinning stays available for self-signed dev certs via ?wthash=.
    // @moq/net accepts hex strings directly (moq-relay prints hex fingerprints)
    const hash = c.wtHash
      ? /^[0-9a-f]+$/i.test(c.wtHash) && c.wtHash.length === 64
        ? c.wtHash
        : Uint8Array.from(atob(c.wtHash), (ch) => ch.charCodeAt(0))
      : undefined;
    const origin = new Moq.Origin.Producer();
    this.originRef = origin;
    // relay auth contract: the VC JWT travels as ?jwt= on the dialed URL; the
    // relay forwards the raw query to its --auth-url hook (our Elixir server),
    // which returns a room-scoped publish/subscribe grant.
    const mediaUrl = new URL(c.media);
    // A relay in --auth-public mode still tries to validate a ?jwt= param and
    // would reject publish; moqauth=0 keeps the URL anonymous on purpose.
    if (c.moqAuth !== false) mediaUrl.searchParams.set("jwt", c.token);
    const tConn = performance.now();
    this.conn = await Moq.Connection.connect({
      url: mediaUrl,
      // an empty object (rather than omitting the key) keeps the
      // WebTransport/WebSocket race intact while trusting the system CA store
      webtransport: hash ? { serverCertificateHashes: [{ value: hash }] } : {},
      publish: origin.consume(),
      consume: origin,
      signal: AbortSignal.timeout(10000),
    });
    c.report("moq-connect", { ms: performance.now() - tConn, version: this.conn.version });

    // IETF MOQT drafts have no standalone datagram objects: a single-frame group
    // is the wire unit and the relay carries it as a QUIC datagram.
    this.ietf = !String(this.conn.version).startsWith("moq-lite");

    // live voice: bound how far behind the live edge a subscriber may replay.
    // The old maxAge=1000 let relays re-serve ~1s of stale audio, which is what
    // produced the 500-1500ms tail under rooms-10 fan-out.
    this.maxAge = Moq.Time.Milli(c.moqMaxAge ?? 150);

    // publish our audio broadcast
    const bc = origin.createBroadcast(Moq.Path.from("vc-bench", c.room, c.id));
    this.track = bc.createTrack("audio", { priority: 128, maxAge: this.maxAge });
    bc.announce();

    this.enc = new AudioEncoder({
      output: (chunk) => {
        const opus = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opus);
        const frame = encodeMediaFrame({
          type: MEDIA_TYPE_AUDIO,
          codec: CODEC_OPUS,
          seq: this.seq++,
          sentMs: Date.now(),
          payload: opus,
        });
        try {
          const payload = new Uint8Array(frame);
          if (this.ietf) {
            const g = this.track!.appendGroup();
            g.writeFrame({ timestamp: Moq.Time.Timestamp.fromMillis(Date.now()), payload });
            g.close();
          } else {
            this.track!.appendDatagram(Moq.Time.Timestamp.fromMillis(Date.now()), payload);
          }
          this.counters.sent++;
        } catch {
          /* oversized or closed */
        }
      },
      error: (e) => c.report("error", { message: `encode: ${e.message}` }),
    });
    // Opus frame duration drives the sender-side quantization floor: the
    // encoder can only emit once a whole frame of PCM has arrived, so a marker
    // waits ~frameDur/2 on average before it is even on the wire.
    this.frameSamples = Math.round((SR * (c.frameDurMs ?? 20)) / 1000);
    const encCfg: AudioEncoderConfig = {
      codec: "opus",
      sampleRate: SR,
      numberOfChannels: 1,
      bitrate: 32000,
      latencyMode: c.latMode as AudioEncoderConfig["latencyMode"],
    };
    if (c.frameDurMs) {
      try {
        const withDur = { ...encCfg, opus: { frameDuration: c.frameDurMs * 1000 } } as AudioEncoderConfig;
        const probe = new AudioEncoder({ output: () => {}, error: () => {} });
        probe.configure(withDur);
        probe.close();
        (encCfg as Record<string, unknown>).opus = { frameDuration: c.frameDurMs * 1000 };
      } catch {
        c.report("warn", { message: `opus frameDuration ${c.frameDurMs}ms unsupported` });
      }
    }
    this.enc.configure(encCfg);
    c.report("moq-enc", { frameSamples: this.frameSamples, latMode: encCfg.latencyMode, frameDurUs: c.frameDurMs ? c.frameDurMs * 1000 : undefined });

    c.audio.onPcm((f32) => this.pushPcm(f32));

    // subscribe to everyone already in the room
    for (const p of c.peers) void this.watchPeer(origin, p);
  }

  private async watchPeer(origin: Moq.Origin.Producer, peerId: string) {
    if (this.subs.has(peerId)) return;
    this.subs.add(peerId);
    const req = origin.request(Moq.Path.from("vc-bench", this.c.room, peerId), {
      announced: true,
    });
    // wait until the broadcast routes
    for (let i = 0; i < 100; i++) {
      const bc = req.active.peek();
      if (bc) {
        const sub = bc.track("audio").subscribe({ maxAge: this.maxAge });
        void this.pumpDatagrams(peerId, sub);
        void this.pumpGroups(peerId, sub);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.c.report("error", { message: `moq: no broadcast for ${peerId}` });
  }

  private async pumpGroups(peerId: string, sub: Moq.Track.Subscriber) {
    try {
      for (;;) {
        const g = await sub.recvGroup();
        if (!g) return;
        for (;;) {
          const fr = await g.readFrame();
          if (!fr) break;
          this.handlePayload(peerId, fr.payload);
        }
      }
    } catch {
      /* subscription reset/closed */
    }
  }

  private async pumpDatagrams(peerId: string, sub: Moq.Track.Subscriber) {
    try {
      for (;;) {
        const dg = await sub.recvDatagram();
        if (!dg) return;
        this.handlePayload(peerId, dg.payload);
      }
    } catch {
      /* subscription reset/closed */
    }
  }

  private handlePayload(peerId: string, payload: Uint8Array) {
        const f = decodeMediaFrame(payload);
        if (!f || f.type !== MEDIA_TYPE_AUDIO) return;
        this.counters.recv++;
        this.counters.bytes += payload.byteLength;
        const lat = Date.now() - f.sentMs;
        this.counters.dgram_rtt_ms.push(lat);
        this.lastLat.set(peerId, lat);

        let dec = this.decs.get(peerId);
        let det = this.dets.get(peerId);
        if (!det) {
          det = createFeedDetector(this.c.ctx, (ctxTime) => {
            // with detJs the JS detector reports; the worklet stays for
            // levels/recording but must not double-report markers
            if (!this.c.detJs) this.c.onDetected(peerId, this.c.clock.toEpoch(ctxTime));
          }, this.c.record, this.c.play);
          det.onpcm = (f) => this.c.onRecvPcm?.(peerId, f);
          this.dets.set(peerId, det);
          if (this.c.detJs) {
            this.jsDets.set(peerId, createJsDetector(this.c.ctx, (t) =>
              this.c.onDetected(peerId, this.c.clock.toEpoch(t))));
          }
        }
        if (!dec) {
          dec = new AudioDecoder({
            output: (ad) => {
              this.counters.fed++;
              const n = ad.numberOfFrames;
              const out = new Float32Array(n);
              ad.copyTo(out, { planeIndex: 0, format: "f32-planar" });
              ad.close();
              this.jsDets.get(peerId)?.(out);
              det!.feed(out);
            },
            error: (e) => this.c.report("error", { message: `decode(${peerId}): ${e.message}` }),
          });
          dec.configure({ codec: "opus", sampleRate: SR, numberOfChannels: 1 });
          this.decs.set(peerId, dec);
        }
        dec.decode(
          new EncodedAudioChunk({ type: "key", timestamp: Math.round(f.sentMs * 1000), data: f.payload }),
        );
  }

  private pushPcm(f32: Float32Array) {
    const merged = new Float32Array(this.acc.length + f32.length);
    merged.set(this.acc);
    merged.set(f32, this.acc.length);
    this.acc = merged;
    while (this.acc.length >= this.frameSamples) {
      const frame = this.acc.subarray(0, this.frameSamples);
      this.acc = this.acc.subarray(this.frameSamples);
      const ad = new AudioData({
        format: "f32-planar",
        sampleRate: SR,
        numberOfFrames: this.frameSamples,
        numberOfChannels: 1,
        timestamp: this.tsUs,
        data: frame.slice().buffer as ArrayBuffer,
      });
      this.tsUs += (this.frameSamples / SR) * 1e6;
      this.enc.encode(ad);
      ad.close();
    }
  }

  handleMsg(m: ServerMsg) {
    // late joiners: subscribe when they appear
    if (m.type === "peer-joined" && this.originRef) {
      void this.watchPeer(this.originRef, m.id);
    }
  }

  async stats(): Promise<Record<string, unknown>[]> {
    const rtts = this.counters.dgram_rtt_ms;
    this.counters.dgram_rtt_ms = [];
    const row: Record<string, unknown> = {
      sent_frames: this.counters.sent,
      recv_frames: this.counters.recv,
      dec_fed: this.counters.fed,
      dec_queue: [...this.decs.values()].reduce((s, d) => s + d.decodeQueueSize, 0),
      recv_bytes: this.counters.bytes,
      levels: Object.fromEntries([...this.dets].map(([id, d]) => [id, +d.level.toFixed(4)])),
      lat_ms: Object.fromEntries([...this.lastLat].map(([id, v]) => [id, Math.round(v * 10) / 10])),
    };
    if (rtts.length) {
      rtts.sort((a, b) => a - b);
      row.dgram_latency_p50 = rtts[Math.floor(rtts.length / 2)];
      row.dgram_latency_max = rtts[rtts.length - 1];
    }
    return [row];
  }

  close() {
    try { this.conn?.close(); } catch {}
    try { this.enc?.close(); } catch {}
    for (const d of this.decs.values()) { try { d.close(); } catch {} }
    this.decs.clear();
    this.dets.clear();
  }
}
