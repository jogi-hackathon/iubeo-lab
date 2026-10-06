// Contract conformance gate for any VC server impl (docs/protocol.md).
// pnpm bench check-server --url ws://localhost:8080
import WebSocket from "ws";
import { mintToken } from "./keys.ts";
import { parseServerMsg, encodeMediaFrame, decodeMediaFrame, MEDIA_TYPE_AUDIO, CODEC_OPUS } from "@vc/protocol";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

type Waiter = { pred: (m: any) => boolean; res: (m: any) => void; to: NodeJS.Timeout };
type WsWithInbox = WebSocket & { __inbox: any[]; __waiters: Waiter[] };

// ws emits 'open' then 'message' synchronously when the 101 response and the
// first frame share a TCP segment — attach the inbox before 'open' resolves.
function connect(url: string, token: string): Promise<WsWithInbox> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`) as WsWithInbox;
    ws.binaryType = "arraybuffer";
    ws.__inbox = [];
    ws.__waiters = [];
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const m = parseServerMsg(data.toString());
      if (!m) return;
      const i = ws.__waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const w = ws.__waiters.splice(i, 1)[0];
        clearTimeout(w.to);
        w.res(m);
      } else {
        ws.__inbox.push(m);
      }
    });
    const to = setTimeout(() => rej(new Error("connect timeout")), 5000);
    ws.on("open", () => { clearTimeout(to); res(ws); });
    ws.on("error", rej);
  });
}

function nextMsg(ws: WsWithInbox, pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  const i = ws.__inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(ws.__inbox.splice(i, 1)[0]);
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout waiting message")), timeoutMs);
    ws.__waiters.push({ pred, res: (m) => { clearTimeout(to); res(m); }, to });
  });
}

export async function checkServer(url: string) {
  // normalize: bare host:port gets the signaling path appended
  const httpBase = new URL(url.replace(/^ws/, "http")).origin;
  if (new URL(url).pathname === "/") url = url.replace(/\/$/, "") + "/v1/signaling";
  const room = `contract-${Date.now()}`;
  const [ta, tb, tc] = await Promise.all(["a", "b", "c"].map((id) => mintToken(id, room)));

  // HTTP endpoints
  try {
    const hz = await fetch(httpBase + "/healthz").then((r) => r.json());
    check("GET /healthz", hz.ok === true);
  } catch (e) { check("GET /healthz", false, String(e)); }

  // join ordering: a gets empty roster, b sees a, c sees a+b
  const a = await connect(url, ta);
  const aPeers = await nextMsg(a, (m) => m.type === "peers");
  check("first msg is peers (empty)", aPeers.peers?.length === 0, JSON.stringify(aPeers));

  const aJoinedB = nextMsg(a, (m) => m.type === "peer-joined" && m.id === "b");
  const b = await connect(url, tb);
  const bPeers = await nextMsg(b, (m) => m.type === "peers");
  check("peers roster for newcomer", JSON.stringify(bPeers.peers) === JSON.stringify([{ id: "a" }]), JSON.stringify(bPeers));
  await aJoinedB;
  check("existing member gets peer-joined", true);

  const aJoinedC = nextMsg(a, (m) => m.type === "peer-joined" && m.id === "c");
  const c = await connect(url, tc);
  await nextMsg(c, (m) => m.type === "peers");
  await aJoinedC;
  check("peer-joined broadcast (3rd)", true);

  // ping/pong
  const t = 1234.5;
  const pong = nextMsg(a, (m) => m.type === "pong" && m.t === t);
  a.send(JSON.stringify({ type: "ping", t }));
  await pong;
  check("ping → pong echo", true);

  // signal routing: a→b reaches b, not c
  const bGot = nextMsg(b, (m) => m.type === "signal" && m.from === "a");
  const cShouldNot = nextMsg(c, (m) => m.type === "signal", 800).then(() => false).catch(() => true);
  a.send(JSON.stringify({ type: "signal", to: "b", data: { sdp: "x" } }));
  await bGot;
  check("signal delivered to target", true);
  check("signal not broadcast to others", await cShouldNot);

  // binary media relay: a → b,c verbatim
  const payload = new Uint8Array([1, 9, 65, 66, 67]);
  const frame = encodeMediaFrame({ type: MEDIA_TYPE_AUDIO, codec: CODEC_OPUS, seq: 7, sentMs: 999.5, payload });
  const gotB = new Promise<Buffer>((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout")), 2000);
    b.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) { clearTimeout(to); res(d); } });
  });
  const gotC = new Promise<Buffer>((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout")), 2000);
    c.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) { clearTimeout(to); res(d); } });
  });
  a.send(frame);
  const [rb, rc] = await Promise.all([gotB, gotC]);
  const okVerbatim = decodeMediaFrame(rb)?.sentMs === 999.5 && decodeMediaFrame(rc)?.seq === 7;
  check("binary media relayed verbatim to other members", okVerbatim);

  // leave propagation
  const aLeft = nextMsg(a, (m) => m.type === "peer-left" && m.id === "b");
  b.close();
  await aLeft;
  check("peer-left broadcast on disconnect", true);

  // metrics sane
  try {
    const m = await fetch(httpBase + "/metrics").then((r) => r.json());
    check("GET /metrics schema", typeof m.ws_connections === "number" && typeof m.rooms === "number", JSON.stringify(m).slice(0, 120));
  } catch (e) { check("GET /metrics", false, String(e)); }

  a.close(); c.close();
  const fails = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - fails}/${checks.length} checks passed${fails ? " — FAILURES PRESENT" : ""}`);
  process.exit(fails ? 1 : 0);
}
