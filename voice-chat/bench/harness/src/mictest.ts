// E2E mic path test: world page with ?voice=mic (fake device) → moq → peer
// levels; then __setMicMuted → peer level ~0; join gate blocks without click.
import { chromium } from "playwright";
import { mintToken } from "./keys.ts";
import { serveClient } from "./serveClient.ts";

const SERVER = "ws://localhost:8081";
const MEDIA = "https://localhost:4443";
const HASH = "5fe68ab3b9c72d299ec663093fc6799995d5a751c86b0836321ee019693eb344";
const ROOM = "room-mic";

const { url: clientUrl, close: closeClient } = await serveClient();
const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const ctx = await browser.newContext();

const mkUrl = async (id: string, index: number, extra: string) => {
  const token = await mintToken(id, ROOM);
  return `${clientUrl}/world?server=${encodeURIComponent(SERVER)}` +
    `&token=${encodeURIComponent(token)}&id=${id}&room=${ROOM}` +
    `&index=${index}&perRoom=2&transport=moq` +
    `&media=${encodeURIComponent(MEDIA)}&wthash=${HASH}&gl=1&fps=15${extra}`;
};

const state = (pg: { evaluate: (f: () => unknown) => Promise<unknown> }) =>
  pg.evaluate(() => (window as any).__state) as Promise<{
    peers?: string[];
    stats?: Record<string, unknown>[];
  } | null>;

// --- p0: world page with real mic path (fake device under headless) ---
const p0 = await ctx.newPage();
p0.on("console", (m) => console.log(`  [p0] ${m.text()}`));
await p0.goto(await mkUrl(`${ROOM}-p0`, 0, "&voice=mic&autojoin=1&nomic=0"));
await p0.waitForFunction(() => (window as any).__state != null, undefined, { timeout: 30000 });
const mute = await p0.evaluate(() => (window as any).__muteState?.());
console.log("p0 joined; muteState:", JSON.stringify(mute));

// --- p1: headless world page, no mic, records received PCM ---
const p1 = await ctx.newPage();
await p1.goto(await mkUrl(`${ROOM}-p1`, 1, "&nomic=1&autojoin=1&record=1"));
await p1.waitForFunction(() => (window as any).__state != null, undefined, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

const st1 = await state(p1);
const lv = (st1?.stats?.[0]?.["levels"] ?? {}) as Record<string, number>;
console.log("p1 levels:", JSON.stringify(lv), "recv:", st1?.stats?.[0]?.["recv_frames"]);
const micAudio = lv[`${ROOM}-p0`] ?? 0;
console.log(micAudio > 0.005 ? `PASS mic audio reached p1 (level ${micAudio})` : `FAIL p0 level ${micAudio}`);

// --- mic mute: p0 mutes, wire should carry digital-silence frames ---
// NOTE: pre-mute audio already inside the send/decode/rec pipeline keeps
// draining for a while — wait 6s, then only the p0 stream must be ~zero.
await p1.evaluate(() => (window as any).__drainRec?.()); // flush pre-mute audio
await p0.evaluate(() => (window as any).__setMicMuted(true));
await new Promise((r) => setTimeout(r, 6000));
const st1b = await state(p1);
const lvb = (st1b?.stats?.[0]?.["levels"] ?? {}) as Record<string, number>;
const sent0 = (await state(p0))?.stats?.[0]?.["sent_frames"] as number ?? 0;
await new Promise((r) => setTimeout(r, 1500));
const rec = await p1.evaluate(() => (window as any).__drainRec?.() ?? {}) as Record<string, string>;
const sent1 = (await state(p0))?.stats?.[0]?.["sent_frames"] as number ?? 0;
console.log("p1 levels after mute:", JSON.stringify(lvb),
  `| p0 sent_frames ${sent0}→${sent1} (keeps sending silence)`);
const b64 = rec[`${ROOM}-p0`];
if (b64) {
  const u8 = Buffer.from(b64, "base64");
  const f32 = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
  let peak = 0, peakAt = 0;
  for (let i = 0; i < f32.length; i++) {
    const a = Math.abs(f32[i]);
    if (a > peak) { peak = a; peakAt = i; }
  }
  // per-second peaks: pre-mute audio in the pipeline lands in the first
  // buckets; a real leak would keep peaks high through the tail
  const sec: string[] = [];
  for (let s = 0; s * 48000 < f32.length; s++) {
    let pk = 0;
    for (let i = s * 48000; i < Math.min(f32.length, (s + 1) * 48000); i++)
      pk = Math.max(pk, Math.abs(f32[i]));
    sec.push(pk.toFixed(3));
  }
  console.log(`pcm ${ROOM}-p0: ${(f32.length / 48000).toFixed(1)}s peak=${peak.toFixed(4)}@${(peakAt / 48000).toFixed(2)}s | per-sec: ${sec.join(" ")}`);
  const tail = f32.slice(Math.floor(f32.length / 2));
  let tpeak = 0;
  for (let i = 0; i < tail.length; i++) tpeak = Math.max(tpeak, Math.abs(tail[i]));
  console.log(tpeak < 0.02 ? "PASS mic mute -> digital silence on wire (tail)"
    : "FAIL audio leaked while muted (tail peak " + tpeak.toFixed(3) + ")");
} else console.log("FAIL no pcm drained");

// --- speaker mute flag + peer mute broadcast on p1's HUD map ---
await p0.evaluate(() => (window as any).__setSpkMuted(true));
const ms = await p0.evaluate(() => (window as any).__muteState());
console.log("p0 muteState:", JSON.stringify(ms));
await new Promise((r) => setTimeout(r, 1500));
const hud = await p1.evaluate(() => document.getElementById("hud")?.textContent ?? "");
console.log(hud.includes("·mut") ? "PASS peer mute flag shown on p1" : `FAIL hud: ${hud.split("\n").slice(-2).join(" ")}`);

// --- join gate: no autojoin → gate blocks connect until click ---
const p2 = await ctx.newPage();
await p2.goto(await mkUrl(`${ROOM}-p2`, 2, "&nomic=1"));
await new Promise((r) => setTimeout(r, 3000));
const gateVisible = await p2.evaluate(() =>
  getComputedStyle(document.getElementById("gate")!).display !== "none");
const stBefore = await state(p2);
console.log(gateVisible && !stBefore ? "PASS join gate blocks connect" :
  `FAIL gate=${gateVisible} state=${stBefore ? "connected" : "none"}`);
await p2.click("#gate");
await p2.waitForFunction(() => (window as any).__state != null, undefined, { timeout: 30000 });
console.log("PASS gate click joins");

await ctx.close();
await browser.close();
closeClient();
console.log("done");
process.exit(0);
