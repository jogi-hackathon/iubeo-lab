import type { Signaling } from "../signaling";
import type { AudioSource, ClockMap } from "../audio/source";
import type { ServerMsg } from "@vc/protocol";

export type Reporter = (kind: string, data: Record<string, unknown>) => void;

export type TransportCtx = {
  id: string;
  room: string;
  peers: string[]; // initial roster
  sig: Signaling;
  audio: AudioSource;
  ctx: AudioContext;
  clock: ClockMap;
  report: Reporter;
  onDetected: (peer: string, epochMs: number) => void;
  record?: boolean; // capture inbound decoded PCM per peer (demo recording)
  gains?: Map<string, number>; // live per-peer attenuation (spatial demo)
  onRecvPcm?: (peer: string, f32: Float32Array) => void;
  token: string; // raw JWT — media relays re-verify it
  media?: string; // media endpoint URL (wt-datagram, moq)
  wtHash?: string; // base64 sha256 of WT server cert (serverCertificateHashes)
  moqMaxAge?: number; // ms — MoQ track/subscription live-edge window (0 = live edge only)
  moqAuth?: boolean; // false = don't append ?jwt= to the relay URL (anonymous/public relays)
  frameDurMs?: number; // Opus frame duration ms (5/10/20; default encoder-side 20)
  latMode?: string; // AudioEncoderConfig latencyMode ("realtime" | "quality")
  detJs?: boolean; // detect markers in JS on decode output instead of the detector worklet
  play?: AudioNode; // audible speaker bus — remote audio renders here; absent = silent bench mode
};

export interface Transport {
  name: string;
  needsPcm?: boolean; // encoder-based transports need the PCM tap; WebRTC mesh uses MediaStreamTrack instead
  start(c: TransportCtx): Promise<void>;
  handleMsg?(m: ServerMsg): void; // signaling messages routed here
  stats(): Promise<Record<string, unknown>[]>;
  close(): void;
}
