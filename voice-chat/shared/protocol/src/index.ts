// VC protocol — shared types & codecs. Erasable-syntax TS only (Node 24 runs this directly).

// ---------- Signaling (JSON text frames) ----------

export type ServerMsg =
  | { type: "peers"; peers: { id: string }[] }
  | { type: "peer-joined"; id: string }
  | { type: "peer-left"; id: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "pong"; t: number }
  | { type: "error"; code: string; message?: string };

export type ClientMsg =
  | { type: "signal"; to: string; data: unknown }
  | { type: "ping"; t: number };

export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw);
    return typeof m?.type === "string" ? (m as ServerMsg) : null;
  } catch {
    return null;
  }
}

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const m = JSON.parse(raw);
    if (m?.type === "signal" && typeof m.to === "string") return m as ClientMsg;
    if (m?.type === "ping" && typeof m.t === "number") return m as ClientMsg;
    return null;
  } catch {
    return null;
  }
}

// ---------- Binary media frame (16-byte header, little-endian) ----------

export const MEDIA_HEADER_BYTES = 16;
export const MEDIA_TYPE_AUDIO = 0x01;
export const CODEC_OPUS = 0x01;

export type MediaFrame = {
  type: number;
  codec: number;
  seq: number;
  sentMs: number;
  payload: Uint8Array;
};

export function encodeMediaFrame(f: MediaFrame): ArrayBuffer {
  const buf = new ArrayBuffer(MEDIA_HEADER_BYTES + f.payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, f.type);
  dv.setUint8(1, f.codec);
  dv.setUint16(2, 0, true);
  dv.setUint32(4, f.seq >>> 0, true);
  dv.setFloat64(8, f.sentMs, true);
  new Uint8Array(buf, MEDIA_HEADER_BYTES).set(f.payload);
  return buf;
}

export function decodeMediaFrame(buf: ArrayBuffer | Uint8Array): MediaFrame | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < MEDIA_HEADER_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    type: dv.getUint8(0),
    codec: dv.getUint8(1),
    seq: dv.getUint32(4, true),
    sentMs: dv.getFloat64(8, true),
    payload: u8.subarray(MEDIA_HEADER_BYTES),
  };
}

// ---------- Metrics ----------

export type ServerMetrics = {
  uptime_s: number;
  ws_connections: number;
  rooms: number;
  peers: number;
  signal_msgs_total: number;
  media_frames_total: number;
  media_bytes_total: number;
  rss_bytes: number;
  cpu_s: number;
};

export type ClientReport = {
  ts: number;
  client: string;
  room: string;
  transport: string;
  kind: "join" | "ctrl-rtt" | "audio-latency" | "rtc" | "media" | "error";
  data: Record<string, unknown>;
};
