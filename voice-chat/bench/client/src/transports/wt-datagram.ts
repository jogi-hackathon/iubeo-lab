import { encodeMediaFrame, decodeMediaFrame, MEDIA_TYPE_AUDIO, CODEC_OPUS } from "@vc/protocol";
import type { ServerMsg } from "@vc/protocol";
import type { Transport, TransportCtx } from "./types";
import { createFeedDetector, type Detector } from "../audio/detector";

const FRAME_SAMPLES = 960; // 20ms @ 48kHz
const SR = 48000;

// WebTransport datagram relay: same media frame format as ws-relay, but frames
// travel as unreliable/unordered QUIC datagrams to a dedicated media relay.
// Signaling (roster/ping/signal) stays on the contract WS connection.
export class WtDatagram implements Transport {
  name = "wt-datagram";
  needsPcm = true;
  private c!: TransportCtx;
  private enc!: AudioEncoder;
  private decs = new Map<string, AudioDecoder>();
  private dets = new Map<string, Detector>();
  private acc = new Float32Array(0);
  private seq = 0;
  private tsUs = 0;
  private counters = { sent: 0, recv: 0, bytes: 0, dgram_rtt_ms: [] as number[] };
  private lastLat = new Map<string, number>();
  private wt?: WebTransport;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;

  private gainTimer?: ReturnType<typeof setInterval>;

  async start(c: TransportCtx): Promise<void> {
    this.c = c;
    this.gainTimer = setInterval(() => {
      for (const [peer, det] of this.dets) det.gain = c.gains?.get(peer) ?? 1;
    }, 250);
    if (!c.media || !c.wtHash) throw new Error("wt-datagram needs media+wthash params");
    const idBytes = new TextEncoder().encode(c.id);

    const hash = Uint8Array.from(atob(c.wtHash), (ch) => ch.charCodeAt(0));
    this.wt = new WebTransport(`${c.media}?token=${encodeURIComponent(c.token)}`, {
      serverCertificateHashes: [{ algorithm: "sha-256", value: hash.buffer as ArrayBuffer }],
      congestionControl: "low-latency",
    });
    const tConn = performance.now();
    await this.wt.ready;
    c.report("wt-connect", { ms: performance.now() - tConn });

    this.writer = this.wt.datagrams.writable.getWriter();

    this.enc = new AudioEncoder({
      output: (chunk) => {
        const opus = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opus);
        const payload = new Uint8Array(1 + idBytes.length + opus.length);
        payload[0] = idBytes.length;
        payload.set(idBytes, 1);
        payload.set(opus, 1 + idBytes.length);
        const frame = encodeMediaFrame({
          type: MEDIA_TYPE_AUDIO,
          codec: CODEC_OPUS,
          seq: this.seq++,
          sentMs: Date.now(),
          payload,
        });
        // datagrams are fire-and-forget; write() resolves when queued
        this.writer!.write(new Uint8Array(frame)).catch(() => {});
        this.counters.sent++;
      },
      error: (e) => c.report("error", { message: `encode: ${e.message}` }),
    });
    this.enc.configure({ codec: "opus", sampleRate: SR, numberOfChannels: 1, bitrate: 32000 });

    c.audio.onPcm((f32) => this.pushPcm(f32));

    // incoming datagram pump
    const reader = this.wt.datagrams.readable.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          this.onFrame(value);
        }
      } catch {
        /* session closed */
      }
    };
    pump();

    this.wt.closed.then(() => c.report("wt-closed", {})).catch(() => {});
  }

  private pushPcm(f32: Float32Array) {
    const merged = new Float32Array(this.acc.length + f32.length);
    merged.set(this.acc);
    merged.set(f32, this.acc.length);
    this.acc = merged;
    while (this.acc.length >= FRAME_SAMPLES) {
      const frame = this.acc.subarray(0, FRAME_SAMPLES);
      this.acc = this.acc.subarray(FRAME_SAMPLES);
      const ad = new AudioData({
        format: "f32-planar",
        sampleRate: SR,
        numberOfFrames: FRAME_SAMPLES,
        numberOfChannels: 1,
        timestamp: this.tsUs,
        data: frame.slice().buffer as ArrayBuffer,
      });
      this.tsUs += (FRAME_SAMPLES / SR) * 1e6;
      this.enc.encode(ad);
      ad.close();
    }
  }

  private onFrame(u8: Uint8Array) {
    const f = decodeMediaFrame(u8);
    if (!f || f.type !== MEDIA_TYPE_AUDIO) return;
    const idLen = f.payload[0];
    const peerId = new TextDecoder().decode(f.payload.subarray(1, 1 + idLen));
    const opus = f.payload.subarray(1 + idLen);
    this.counters.recv++;
    this.counters.bytes += u8.byteLength;
    // one-way media-path latency observed at arrival (epoch clock shared)
    const lat = Date.now() - f.sentMs;
    this.counters.dgram_rtt_ms.push(lat);
    this.lastLat.set(peerId, lat);

    let dec = this.decs.get(peerId);
    let det = this.dets.get(peerId);
    if (!det) {
      det = createFeedDetector(this.c.ctx, (ctxTime) =>
        this.c.onDetected(peerId, this.c.clock.toEpoch(ctxTime)),
      this.c.record, this.c.play);
      det.onpcm = (f) => this.c.onRecvPcm?.(peerId, f);
      this.dets.set(peerId, det);
    }
    if (!dec) {
      dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames;
          const out = new Float32Array(n);
          ad.copyTo(out, { planeIndex: 0, format: "f32-planar" });
          ad.close();
          det!.feed(out);
        },
        error: (e) => this.c.report("error", { message: `decode(${peerId}): ${e.message}` }),
      });
      dec.configure({ codec: "opus", sampleRate: SR, numberOfChannels: 1 });
      this.decs.set(peerId, dec);
    }
    dec.decode(
      new EncodedAudioChunk({ type: "key", timestamp: Math.round(f.sentMs * 1000), data: opus }),
    );
  }

  handleMsg(_m: ServerMsg) {}

  async stats(): Promise<Record<string, unknown>[]> {
    const rtts = this.counters.dgram_rtt_ms;
    this.counters.dgram_rtt_ms = [];
    const row: Record<string, unknown> = {
      sent_frames: this.counters.sent,
      recv_frames: this.counters.recv,
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
    try { this.writer?.releaseLock(); } catch {}
    try { this.wt?.close(); } catch {}
    try { this.enc?.close(); } catch {}
    for (const d of this.decs.values()) { try { d.close(); } catch {} }
    this.decs.clear();
    this.dets.clear();
  }
}
