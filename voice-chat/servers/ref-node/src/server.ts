// Reference VC server — implements docs/protocol.md. Correctness oracle for other impls.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { importJWK, jwtVerify, type KeyLike, type JWK } from "jose";
import { parseClientMsg } from "@vc/protocol";

const PORT = Number(process.env.PORT ?? 8080);
const ROOM_MAX = Number(process.env.ROOM_MAX ?? 8);
const t0 = Date.now();

type Peer = { id: string; ws: WebSocket };
const rooms = new Map<string, Map<string, Peer>>(); // roomId -> peerId -> peer

const stats = {
  signal_msgs_total: 0,
  media_frames_total: 0,
  media_bytes_total: 0,
};

async function loadPublicKey(): Promise<KeyLike | Uint8Array> {
  const jwk: JWK = process.env.VC_PUBLIC_JWK
    ? JSON.parse(process.env.VC_PUBLIC_JWK)
    : JSON.parse(readFileSync(new URL("../../../bench/dev-keys/public.jwk", import.meta.url), "utf8"));
  return (await importJWK(jwk, "EdDSA")) as KeyLike | Uint8Array;
}

const publicKey = await loadPublicKey();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Map<string, Peer>, excludeId: string, msg: unknown) {
  const s = JSON.stringify(msg);
  for (const p of room.values()) {
    if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (url.pathname === "/metrics") {
    const cpu = process.cpuUsage();
    const body = JSON.stringify({
      uptime_s: (Date.now() - t0) / 1000,
      ws_connections: [...rooms.values()].reduce((n, r) => n + r.size, 0),
      rooms: rooms.size,
      peers: [...rooms.values()].reduce((n, r) => n + r.size, 0),
      signal_msgs_total: stats.signal_msgs_total,
      media_frames_total: stats.media_frames_total,
      media_bytes_total: stats.media_bytes_total,
      rss_bytes: process.memoryUsage().rss,
      cpu_s: (cpu.user + cpu.system) / 1e6,
    });
    res.writeHead(200, { "content-type": "application/json" }).end(body);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/v1/signaling") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token");
  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  let sub: string, roomId: string;
  try {
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"] });
    if (!payload.sub || typeof payload.room !== "string") throw new Error("missing claims");
    sub = payload.sub;
    roomId = payload.room;
  } catch {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onJoin(ws, sub, roomId));
});

function onJoin(ws: WebSocket, id: string, roomId: string) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.has(id) || room.size >= ROOM_MAX) {
    ws.close(4413, "room full or duplicate id");
    return;
  }
  const existing = [...room.keys()];
  room.set(id, { id, ws });
  send(ws, { type: "peers", peers: existing.map((eid) => ({ id: eid })) });
  broadcast(room, id, { type: "peer-joined", id });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      stats.media_frames_total++;
      stats.media_bytes_total += data.byteLength;
      for (const p of room!.values()) {
        if (p.id !== id && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
      }
      return;
    }
    const msg = parseClientMsg(data.toString());
    if (!msg) return;
    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t });
    } else if (msg.type === "signal") {
      stats.signal_msgs_total++;
      const target = room!.get(msg.to);
      if (target) send(target.ws, { type: "signal", from: id, data: msg.data });
      else send(ws, { type: "error", code: "no_such_peer", message: msg.to });
    }
  });

  ws.on("close", () => {
    room!.delete(id);
    broadcast(room!, id, { type: "peer-left", id });
    if (room!.size === 0) rooms.delete(roomId);
  });
}

http.listen(PORT, () => console.log(`[ref-node] ws://localhost:${PORT}/v1/signaling`));
