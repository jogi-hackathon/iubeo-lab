// Protocol smoke test against a DEPLOYED vc service.
//
//   node deploy/verify.mjs https://vc.thirdlf03.com
//
// Uses the server's own POST /v1/join to mint tokens, so it needs no private
// key locally (a production host signs with keys that never leave it). Checks
// the parts of docs/protocol.md a browser cannot easily show you:
// healthz, lobby room listing, roster/peer-joined/peer-left, ping->pong, and
// the binary media relay (delivered to peers, never echoed to the sender).
//
// Dependency-free: node's global WebSocket (Node >= 22).
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node deploy/verify.mjs https://vc.example.com");
  process.exit(2);
}
const wsBase = base.replace(/^http/, "ws");
const ROOM = `verify-${Date.now().toString(36)}`;
let failures = 0;
const ok = (m) => console.log("ok   ", m);
const bad = (m) => { failures++; console.error("FAIL ", m); };

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

async function join(name) {
  const r = await fetch(`${base}/v1/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: ROOM, name }),
  });
  if (!r.ok) throw new Error(`/v1/join ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.id || !j.token) throw new Error(`/v1/join bad body: ${JSON.stringify(j)}`);
  return j;
}

// A WebSocket that records every text message and binary frame.
function connect(token) {
  const url = `${wsBase}/v1/signaling?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  // node's WebSocket hands binary frames over as Blobs by default
  ws.binaryType = "arraybuffer";
  const client = { ws, texts: [], binaries: [], closed: null, next(type) {
    return withTimeout(new Promise((res) => {
      const found = client.texts.find((m) => m.type === type);
      if (found) return res(found);
      client.waiters.push({ type, res });
    }), 8000, `ws message ${type}`);
  }, waiters: [] };
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      client.texts.push(msg);
      for (let i = client.waiters.length - 1; i >= 0; i--) {
        if (client.waiters[i].type === msg.type) client.waiters.splice(i, 1)[0].res(msg);
      }
    } else {
      client.binaries.push(new Uint8Array(ev.data));
    }
  });
  ws.addEventListener("close", (ev) => { client.closed = ev.code; });
  client.open = withTimeout(new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
    ws.addEventListener("close", (ev) => rej(new Error(`ws closed early (${ev.code})`)));
  }), 8000, "ws open");
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. healthz
  const h = await fetch(`${base}/healthz`);
  (h.ok ? ok : bad)(`/healthz -> ${h.status}`);

  // 2. join, then connect: the lobby lists rooms with live members, so the
  // listing only contains this room once the signaling socket is up.
  const a = await join("verify-a");
  ok(`/v1/join minted ${a.id}`);
  const c1 = connect(a.token);
  await c1.open;
  const peers1 = await c1.next("peers");
  (Array.isArray(peers1.peers) ? ok : bad)(`roster on join: ${JSON.stringify(peers1.peers)}`);

  const rooms = await (await fetch(`${base}/v1/rooms`)).json();
  const room = (rooms.rooms ?? []).find((r) => r.name === ROOM);
  (room && room.members >= 1 ? ok : bad)(`/v1/rooms lists ${ROOM} (members=${room?.members})`);

  // 3. peer-joined + ping/pong + media relay
  const b = await join("verify-b");
  const c2 = connect(b.token);
  await c2.open;
  await c2.next("peers");
  const joined = await c1.next("peer-joined");
  (joined.id === b.id ? ok : bad)(`peer-joined ${joined.id} (expected ${b.id})`);

  c1.ws.send(JSON.stringify({ type: "ping", t: 1234.5 }));
  const pong = await c1.next("pong");
  (pong.t === 1234.5 ? ok : bad)(`ping -> pong t=${pong.t}`);

  // 16-byte little-endian media header + payload, per docs/protocol.md §3
  const frame = new Uint8Array(16 + 4);
  const dv = new DataView(frame.buffer);
  dv.setUint8(0, 0x01); // audio
  dv.setUint8(1, 0x01); // opus
  dv.setUint32(4, 7, true); // seq
  dv.setFloat64(8, Date.now(), true); // sent_ms
  frame.set([1, 2, 3, 4], 16);
  c1.ws.send(frame);
  await withTimeout((async () => {
    while (c2.binaries.length === 0) await sleep(50);
  })(), 8000, "media relay delivery");
  (c2.binaries[0].length === frame.length ? ok : bad)(`media relay delivered ${c2.binaries[0].length}B`);
  const echoed = c2.binaries[0].length === frame.length &&
    frame.every((v, i) => c2.binaries[0][i] === v);
  (echoed ? ok : bad)("relayed frame is byte-identical (opaque relay)");
  await sleep(300);
  (c1.binaries.length === 0 ? ok : bad)("media relay did not echo to the sender");

  // 4. peer-left on close
  c2.ws.close();
  const left = await c1.next("peer-left");
  (left.id === b.id ? ok : bad)(`peer-left ${left.id}`);

  c1.ws.close();
} catch (err) {
  bad(String(err && err.message ? err.message : err));
}

console.log(failures === 0 ? "\nVERIFY PASS" : `\nVERIFY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
