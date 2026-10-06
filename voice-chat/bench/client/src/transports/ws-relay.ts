import { encodeMediaFrame, decodeMediaFrame, MEDIA_TYPE_AUDIO, CODEC_OPUS } from "@vc/protocol";
import type { ServerMsg } from "@vc/protocol";
import type { Transport, TransportCtx } from "./types";
import { createFeedDetector, type Detector } from "../audio/detector";

const FRAME_SAMPLES = 960; // 20ms @ 48kHz
const SR = 48000;

// WS media relay: Opus via WebCodecs over binary WS frames. Server relays verbatim.
// Payload inside our opaque media frame: [u8 idLen][utf8 id][opus bytes] — keeps sender identity
// (server only routes, never inspects).
export class WsRelay implements Transport {
  name = "ws-relay";
  needsPcm = true;
  private c!: TransportCtx;
  private enc!: AudioEncoder;
  private decs = new Map<string, AudioDecoder>();
  private dets = new Map<string, Detector>();
  private acc = new Float32Array(0);
  private seq = 0;
  private tsUs = 0;
  private counters = { sent: 0, recv: 0, bytes: 0 };
  private lastLat = new Map<string, number>();
  private binaryHook?: (b: ArrayBuffer) => void;

  private gainTimer?: ReturnType<typeof setInterval>;

  async start(c: TransportCtx): Promise<void> {
    this.c = c;
    this.gainTimer = setInterval(() => {
      for (const [peer, det] of this.dets) det.gain = c.gains?.get(peer) ?? 1;
    }, 250);
    const idBytes = new TextEncoder().encode(c.id);

    this.enc = new AudioEncoder({
      output: (chunk) => {
        const opus = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opus);
        const payload = new Uint8Array(1 + idBytes.length + opus.length);
        payload[0] = idBytes.length;
        payload.set(idBytes, 1);
        payload.set(opus, 1 + idBytes.length);
        c.sig.sendBinary(
          encodeMediaFrame({
            type: MEDIA_TYPE_AUDIO,
            codec: CODEC_OPUS,
            seq: this.seq++,
            sentMs: Date.now(),
            payload,
          }),
        );
        this.counters.sent++;
      },
      error: (e) => c.report("error", { message: `encode: ${e.message}` }),
    });
    this.enc.configure({ codec: "opus", sampleRate: SR, numberOfChannels: 1, bitrate: 32000 });

    c.audio.onPcm((f32) => this.pushPcm(f32));

    // Hook the shared WS binary stream (main.ts forwards to transports that opt in)
    this.binaryHook = (buf) => this.onFrame(buf);
    c.sig.onBinary = this.binaryHook;
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

  private onFrame(buf: ArrayBuffer) {
    const f = decodeMediaFrame(buf);
    if (!f || f.type !== MEDIA_TYPE_AUDIO) return;
    const idLen = f.payload[0];
    const peerId = new TextDecoder().decode(f.payload.subarray(1, 1 + idLen));
    const opus = f.payload.subarray(1 + idLen);
    this.counters.recv++;
    this.counters.bytes += buf.byteLength;
    this.lastLat.set(peerId, Date.now() - f.sentMs);

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
    return [{
      sent_frames: this.counters.sent,
      recv_frames: this.counters.recv,
      recv_bytes: this.counters.bytes,
      levels: Object.fromEntries([...this.dets].map(([id, d]) => [id, +d.level.toFixed(4)])),
      lat_ms: Object.fromEntries([...this.lastLat].map(([id, v]) => [id, Math.round(v * 10) / 10])),
    }];
  }

  close() {
    clearInterval(this.gainTimer);
    try { this.enc.close(); } catch {}
    for (const d of this.decs.values()) { try { d.close(); } catch {} }
    this.decs.clear();
    this.dets.clear();
  }
}
