import { Signaling } from "./signaling";
import { buildSource, makeClockMap } from "./audio/source";
import { loadWorklets } from "./audio/worklets";
import type { Transport } from "./transports/types";
import { WebRTCMesh } from "./transports/webrtc-mesh";
import { WsRelay } from "./transports/ws-relay";
import { WtDatagram } from "./transports/wt-datagram";
import { MoqTransport } from "./transports/moq";

declare global {
  interface Window {
    __report?: (batch: unknown) => void;
    __state?: unknown;
  }
}

const transports: Record<string, () => Transport> = {
  "webrtc-mesh": () => new WebRTCMesh(),
  "ws-relay": () => new WsRelay(),
  "wt-datagram": () => new WtDatagram(),
  moq: () => new MoqTransport(),
};

async function main() {
  const p = new URLSearchParams(location.search);
  const server = p.get("server")!;                    // e.g. ws://localhost:8080
  const token = p.get("token")!;
  const id = p.get("id")!;
  const room = p.get("room")!;
  const transportName = p.get("transport") ?? "webrtc-mesh";
  const index = Number(p.get("index") ?? 0);
  const perRoom = Number(p.get("perRoom") ?? 3);
  const navStart = performance.now();

  // report batching -> harness via exposed function
  const pending: unknown[] = [];
  const report = (kind: string, data: Record<string, unknown>) => {
    pending.push({ ts: Date.now(), client: id, room, transport: transportName, kind, data });
  };
  setInterval(() => {
    if (pending.length && window.__report) {
      window.__report(pending.splice(0));
    }
  }, 1000);

  try {
    const transport = transports[transportName]();

    // inbound PCM recording (demo): harness drains via __drainRec() -> base64 f32
    const recChunks = new Map<string, Float32Array[]>();
    const record = p.get("record") === "1";
    const pushRec = (peer: string, f32: Float32Array) => {
      let a = recChunks.get(peer);
      if (!a) { a = []; recChunks.set(peer, a); }
      a.push(f32);
    };

    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    await loadWorklets(ctx);
    const clock = makeClockMap(ctx);
    const voiceParam = p.get("voice");
    const audio = await buildSource(ctx, index, perRoom, (epochMs) =>
      report("marker-sent", { epoch_ms: epochMs }),
    clock, {
      pcmTap: (transport.needsPcm ?? false) || record,
      voiceUrl: voiceParam === "mic" ? undefined : voiceParam ?? undefined,
      mic: voiceParam === "mic",
      markers: p.get("markers") !== "0",
      captureChunk: p.get("capchunk") != null ? Number(p.get("capchunk")) : undefined,
    });
    const onDetected = (peer: string, epochMs: number) =>
      report("marker-detected", { peer, epoch_ms: epochMs });

    // own voice (pre-encode "sidetone") — lets the recording include self speech
    if (record) audio.onPcm((f) => pushRec("self", f));

    // spatial attenuation: harness updates __gains in place; transports apply
    // per-peer gain when feeding decoded PCM into the detector (and recorder)
    const peerGains = new Map<string, number>();
    (window as any).__gains = peerGains;
    (window as any).__drainRec = () => {
      const out: Record<string, string> = {};
      for (const [peer, chunks] of recChunks) {
        const total = chunks.reduce((n2, c2) => n2 + c2.length, 0);
        if (!total) continue;
        const f = new Float32Array(total);
        let o = 0;
        for (const c2 of chunks) { f.set(c2, o); o += c2.length; }
        chunks.length = 0;
        const u8 = new Uint8Array(f.buffer);
        let bin = "";
        for (let i = 0; i < u8.length; i += 8192)
          bin += String.fromCharCode(...u8.subarray(i, i + 8192));
        out[peer] = btoa(bin);
      }
      return out;
    };

    const sig = new Signaling(`${server}/v1/signaling?token=${encodeURIComponent(token)}`);
    await sig.ready;

    // join: wait for roster
    const peers = await new Promise<string[]>((res) => {
      const prev = sig.onMsg;
      sig.onMsg = (m) => {
        if (m.type === "peers") res(m.peers.map((x) => x.id));
        else transport.handleMsg?.(m);
        prev(m);
      };
    });
    report("join", { ws_open_ms: null, joined_ms: performance.now() - navStart, peers: peers.length });
    const roster = new Set(peers);
    const peerPos = new Map<string, number[]>();
    sig.onMsg = (m) => {
      if (m.type === "pong") report("ctrl-rtt", { rtt_ms: performance.now() - m.t });
      else if (m.type === "peer-joined") { roster.add(m.id); transport.handleMsg?.(m); }
      else if (m.type === "peer-left") { roster.delete(m.id); peerPos.delete(m.id); transport.handleMsg?.(m); }
      else if (m.type === "signal" && Array.isArray((m.data as { pos?: number[] })?.pos))
        peerPos.set(m.from, (m.data as { pos: number[] }).pos);
      else transport.handleMsg?.(m);
    };

    // optional position sharing over the game channel (?pos=x,z). The harness
    // can move a client with __setPos(); peers receive 10Hz {pos:[x,z]} signals.
    const posParam = (p.get("pos") ?? "").split(",").map(Number);
    let myPos: number[] | null =
      posParam.length === 2 && posParam.every(Number.isFinite) ? posParam : null;
    (window as any).__setPos = (x: number, z: number) => { myPos = [x, z]; };
    (window as any).__peerPos = peerPos;
    setInterval(() => {
      if (!myPos) return;
      for (const peer of roster) sig.send({ type: "signal", to: peer, data: { pos: myPos } });
    }, 100);

    await transport.start({
      id, room, peers, sig, audio, ctx, clock, report, onDetected,
      record,
      gains: peerGains,
      onRecvPcm: record ? pushRec : undefined,
      token,
      media: p.get("media") ?? undefined,
      wtHash: p.get("wthash") ?? undefined,
      moqMaxAge: p.get("moqmaxage") != null ? Number(p.get("moqmaxage")) : undefined,
      moqAuth: p.get("moqauth") !== "0",
      frameDurMs: p.get("framedur") != null ? Number(p.get("framedur")) : undefined,
      latMode: p.get("latmode") ?? undefined,
      detJs: p.get("detjs") === "1",
    });

    // control RTT probe
    setInterval(() => sig.send({ type: "ping", t: performance.now() }), 1000);

    // transport stats loop (250ms: feeds both the report and the live __state
    // snapshot that the demo dashboard polls)
    setInterval(async () => {
      try {
        const rows = await transport.stats();
        window.__state = {
          id, room, transport: transportName, peers,
          stats: rows, ts: Date.now(),
        };
        for (const s of rows) {
          report(transportName === "webrtc-mesh" ? "rtc" : "media", s);
        }
      } catch {}
    }, 250);

    window.__report?.([{ ts: Date.now(), client: id, room, transport: transportName, kind: "ready", data: {} }]);
  } catch (e) {
    report("error", { message: String(e) });
  }
}

main();
