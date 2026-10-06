// End-to-end check against a DEPLOYED demo: two walk-in clients (no local
// server, no dev keys) meet in a room over the real moq/WebTransport path.
//
//   node bench/harness/src/deploy-e2e.ts https://vc.thirdlf03.com
//
// Asserts what deploy/verify.mjs cannot: the lobby page loads, both browsers
// join through POST /v1/join, the rosters converge over WSS, and WebCodecs Opus
// frames actually cross the QUIC relay and decode (recv_frames / levels). The
// carrier tone is the source (?nomic=1), so no mic permission is involved.
import { chromium } from "playwright";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node bench/harness/src/deploy-e2e.ts https://vc.example.com");
  process.exit(2);
}
const room = `e2e-${Date.now().toString(36)}`;
let failures = 0;
const ok = (m: string) => console.log("ok   ", m);
const bad = (m: string) => { failures++; console.error("FAIL ", m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = {
  id: string;
  transport: string;
  peers: string[];
  stats: Record<string, unknown>[];
  pos: [number, number];
};

const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const ctx = await browser.newContext();
const getState = (pg: import("playwright").Page) =>
  pg.evaluate(() => (window as any).__state) as Promise<State | null>;

async function open(name: string): Promise<import("playwright").Page> {
  const pg = await ctx.newPage();
  pg.on("console", (m) => {
    const t = m.text();
    if (/error|fail|refus/i.test(t)) console.log(`  [${name}] ${t}`);
  });
  pg.on("pageerror", (e) => console.log(`  [${name}] pageerror ${e.message}`));
  await pg.goto(
    // gl=1 forces the WebGL2 backend (headless has no usable WebGPU device),
    // fps=15 keeps the page cheap so the decoder is not starved
    `${base}/world?room=${encodeURIComponent(room)}&name=${name}` +
      `&autojoin=1&nomic=1&debug=1&gl=1&fps=15`,
  );
  await pg.waitForFunction(() => (window as any).__state != null, undefined, { timeout: 60000 });
  return pg;
}

try {
  // --- lobby page: served, and listing live rooms from /v1/rooms ------------
  const lobby = await ctx.newPage();
  await lobby.goto(`${base}/`);
  const title = await lobby.title();
  (title.includes("vc world") ? ok : bad)(`lobby served (title "${title}")`);
  await lobby
    .waitForFunction(() => document.querySelectorAll("#rooms li").length > 0, undefined, { timeout: 20000 })
    .then(() => ok("lobby listed rooms from /v1/rooms"))
    .catch(() => bad("lobby room list stayed empty"));
  await lobby.close();

  // --- two walk-in clients -------------------------------------------------
  const p0 = await open("e2e-a");
  const s0 = (await getState(p0))!;
  ok(`p0 joined as ${s0.id} via /v1/join (transport ${s0.transport})`);

  const p1 = await open("e2e-b");
  const s1 = (await getState(p1))!;
  ok(`p1 joined as ${s1.id} via /v1/join`);

  await p0
    .waitForFunction((id) => (window as any).__state?.peers?.includes(id), s1.id, { timeout: 20000 })
    .then(() => ok("p0 roster contains p1"))
    .catch(() => bad("p0 never saw p1"));
  await p1
    .waitForFunction((id) => (window as any).__state?.peers?.includes(id), s0.id, { timeout: 20000 })
    .then(() => ok("p1 roster contains p0"))
    .catch(() => bad("p1 never saw p0"));

  // --- move them inside the hearing radius so attenuation is 1 -------------
  // (clients spawn on a random ring, so without this the mix can be silent)
  await p0.evaluate(() => (window as any).__moveTo?.(0, 0));
  await p1.evaluate(() => (window as any).__moveTo?.(4, 0));
  await sleep(3000);

  // --- audio over WebTransport --------------------------------------------
  await sleep(9000);
  const t0 = (await getState(p0))!;
  const t1 = (await getState(p1))!;
  const row = (s: State) => s.stats[0] ?? {};
  const num = (s: State, k: string) => Number(row(s)[k] ?? 0);
  console.log(
    `  p0 sent=${num(t0, "sent_frames")} recv=${num(t0, "recv_frames")} decq=${num(t0, "dec_queue")}` +
      `  |  p1 sent=${num(t1, "sent_frames")} recv=${num(t1, "recv_frames")} decq=${num(t1, "dec_queue")}`,
  );
  (num(t0, "sent_frames") > 0 && num(t1, "sent_frames") > 0 ? ok : bad)(
    "both clients encoded + published Opus frames",
  );
  (num(t0, "recv_frames") > 0 && num(t1, "recv_frames") > 0 ? ok : bad)(
    "both clients received + decoded the peer over WebTransport",
  );

  const lv0 = (row(t0).levels ?? {}) as Record<string, number>;
  const lv1 = (row(t1).levels ?? {}) as Record<string, number>;
  console.log(`  p0 levels=${JSON.stringify(lv0)}  p1 levels=${JSON.stringify(lv1)}`);
  const heard = Object.values(lv0).some((v) => v > 0.001) && Object.values(lv1).some((v) => v > 0.001);
  (heard ? ok : bad)("audio is audible on both sides (post-attenuation levels > 0)");
} catch (e) {
  bad(String(e instanceof Error ? e.message : e));
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
