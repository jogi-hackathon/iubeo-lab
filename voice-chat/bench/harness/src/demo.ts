import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, Socket } from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mintToken } from "./keys.ts";
import { serveClient } from "./serveClient.ts";

// Live dashboard demo: N real headless-Chrome VC clients plus a dashboard page
// that visualizes per-peer audio levels + media latency, recorded to a .webm
// video via Playwright's recordVideo.
//
// Layout:
//   context A (recorded): 1 dashboard page — polls nothing itself; the harness
//     pushes window.__vc = [...clientStates] every 200ms and the page draws.
//   context B (not recorded): N client pages running the real bench client.
const DASH_HTML = `<!doctype html><meta charset="utf-8"><title>vc-bench demo</title>
<style>
  body { background: #0d1117; color: #e6edf3; font: 14px/1.4 ui-monospace,monospace; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 20px; }
  .wrap { display: flex; gap: 20px; align-items: flex-start; }
  .grid { display: flex; flex-direction: column; gap: 12px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; width: 430px; }
  .cid { font-weight: 700; font-size: 16px; margin-bottom: 8px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .peer { width: 110px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .bar { flex: 1; height: 14px; background: #21262d; border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: #3fb950; width: 0%; transition: width 120ms; }
  .lat { width: 70px; text-align: right; color: #d29922; font-size: 12px; }
  .rms { width: 60px; text-align: right; color: #8b949e; font-size: 11px; }
  .meta { color: #8b949e; font-size: 12px; margin-top: 10px; border-top: 1px solid #21262d; padding-top: 8px; }
  .none { color: #484f58; font-size: 12px; margin: 6px 0; }
  canvas { background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
</style>
<h1>vc-bench live VC</h1>
<div class="sub" id="sub">waiting…</div>
<div class="wrap">
  <div class="grid" id="grid"></div>
  <div>
    <canvas id="map" width="700" height="560"></canvas>
    <div class="meta">spatial map (positions simulated · edge = inbound audio · line width = level)</div>
  </div>
</div>
<script>
const grid = document.getElementById("grid");
const sub = document.getElementById("sub");
const cv = document.getElementById("map");
const g2 = cv.getContext("2d");
const cards = new Map();
function esc(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function peersOf(c) {
  const row0 = c.stats && c.stats[0] || {};
  const levels = row0.levels || {};
  const rtc = {};
  for (const r of (c.stats || [])) if (r.peer) rtc[r.peer] = r;
  const peers = Object.keys(levels).length ? Object.keys(levels)
    : Object.keys(rtc).length ? Object.keys(rtc) : c.peers;
  return { row0, levels, lats: row0.lat_ms || {}, rtc, peers };
}
function render() {
  const st = window.__vc || [];
  if (!st.length) { sub.textContent = "waiting for clients…"; return; }
  sub.textContent = st[0].transport + " | room " + st[0].room + " | " + st.length +
    " clients | " + new Date().toLocaleTimeString();
  for (const c of st) {
    let card = cards.get(c.id);
    if (!card) { card = document.createElement("div"); card.className = "card"; grid.appendChild(card); cards.set(c.id, card); }
    const { row0, levels, lats, rtc, peers } = peersOf(c);
    let html = '<div class="cid">' + esc(c.id) + '</div>';
    if (!peers.length) html += '<div class="none">no inbound audio yet</div>';
    for (const p of peers) {
      const lv = levels[p] ?? rtc[p]?.audio_level ?? 0;
      const lat = lats[p] ?? (rtc[p]?.rtt_ms != null ? "rtt " + rtc[p].rtt_ms.toFixed(0) : "—");
      const pct = Math.min(100, Math.round(lv * 500));
      html += '<div class="row"><span class="peer">← ' + esc(p) + '</span>' +
        '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<span class="rms">' + lv.toFixed(3) + '</span>' +
        '<span class="lat">' + (typeof lat === "number" ? lat + "ms" : lat) + '</span></div>';
    }
    html += '<div class="meta">sent ' + (row0.sent_frames ?? "—") + ' · recv ' + (row0.recv_frames ?? "—") + ' frames</div>';
    card.innerHTML = html;
  }
}
// top-down spatial view: positions pushed by harness (window.__pos: id->[x,y])
const pos = new Map();
function draw() {
  const st = window.__vc || [];
  const P = window.__pos || {};
  g2.clearRect(0, 0, cv.width, cv.height);
  st.forEach((c, i) => {
    const p = P[c.id];
    if (p) pos.set(c.id, { x: p[0], y: p[1] });
    else if (!pos.has(c.id)) {
      const a = -Math.PI / 2 + (i / Math.max(1, st.length)) * Math.PI * 2;
      pos.set(c.id, { x: cv.width / 2 + Math.cos(a) * 200, y: cv.height / 2 + Math.sin(a) * 200 });
    }
  });
  const lvl = {};
  for (const c of st) {
    const { levels, rtc, peers } = peersOf(c);
    for (const p of peers) lvl[c.id + "←" + p] = levels[p] ?? rtc[p]?.audio_level ?? 0;
  }
  for (const c of st) {
    const { peers } = peersOf(c);
    for (const p of peers) {
      const a = pos.get(c.id), b = pos.get(p);
      if (!a || !b) continue;
      const lv = lvl[c.id + "←" + p] || 0;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      g2.beginPath();
      g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y);
      g2.strokeStyle = "rgba(63,185,80," + Math.min(1, 0.15 + lv * 8) + ")";
      g2.lineWidth = 1 + Math.min(8, lv * 60);
      g2.stroke();
      // distance label
      g2.fillStyle = "#484f58"; g2.font = "10px monospace"; g2.textAlign = "center";
      g2.fillText(d.toFixed(0) + "u", (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
    }
  }
  for (const c of st) {
    const p = pos.get(c.id);
    // full-volume radius ring (gain=1 within 180u)
    g2.beginPath(); g2.arc(p.x, p.y, 180, 0, Math.PI * 2);
    g2.strokeStyle = "rgba(33,38,45,0.9)"; g2.lineWidth = 1; g2.stroke();
    g2.beginPath(); g2.arc(p.x, p.y, 46, 0, Math.PI * 2);
    g2.strokeStyle = "#30363d"; g2.lineWidth = 1; g2.stroke();
    g2.beginPath(); g2.arc(p.x, p.y, 16, 0, Math.PI * 2);
    g2.fillStyle = "#58a6ff"; g2.fill();
    g2.fillStyle = "#e6edf3"; g2.font = "11px monospace"; g2.textAlign = "center";
    g2.fillText(c.id, p.x, p.y - 54);
  }
  requestAnimationFrame(draw);
}
setInterval(render, 120);
requestAnimationFrame(draw);
</script>`;

function serveDashboard(voices: string[] = []): Promise<{ url: string; close(): void }> {
  const server: Server = createServer((req, res) => {
    const v = /^\/v\/(\d+)\.wav$/.exec(req.url ?? "");
    if (v && voices[+v[1]]) {
      res.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" })
        .end(readFileSync(voices[+v[1]]));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(DASH_HTML);
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() })));
}

// TCP "chaos" proxy: forwards upstream untouched, but on the downstream holds
// each received chunk until its release time — releases are monotonic, so a
// stall on one chunk holds everything behind it, exactly like a packet loss +
// retransmit does to a TCP byte stream. To the client this *is* HOL blocking.
function tcpChaosProxy(upstream: URL, o: { delay: number; jitter: number; stallP: number; stallMs: number }):
  Promise<{ url: string; close(): void }> {
  const port = Number(upstream.port || 80);
  const host = upstream.hostname;
  const srv = createTcpServer((down) => {
    const up = new Socket();
    up.connect(port, host);
    down.pipe(up); // upstream direction: pass through
    // downstream: queue chunks with monotonic release times
    const q: { buf: Buffer; at: number }[] = [];
    let lastRelease = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pump = () => {
      timer = undefined;
      const now = Date.now();
      while (q.length && q[0].at <= now) down.write(q.shift()!.buf);
      if (q.length) timer = setTimeout(pump, q[0].at - now);
    };
    up.on("data", (buf: Buffer) => {
      const at = Math.max(
        lastRelease,
        Date.now() + o.delay + o.jitter * Math.random() + (Math.random() < o.stallP ? o.stallMs : 0),
      );
      lastRelease = at;
      q.push({ buf: Buffer.from(buf), at });
      if (!timer) pump();
    });
    const kill = () => { up.destroy(); down.destroy(); };
    up.on("error", kill); down.on("error", kill);
    up.on("close", () => down.destroy()); down.on("close", () => up.destroy());
  });
  return new Promise((res) =>
    srv.listen(0, "127.0.0.1", () =>
      res({ url: `ws://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

export async function demo(opts: {
  server: string; transport: string; clients?: number; seconds?: number; out?: string;
  media?: string; mediahash?: string; voices?: string[]; audio?: boolean; self?: boolean;
  chaos?: string; uchaos?: string;
}) {
  const n = opts.clients ?? 3;
  const seconds = opts.seconds ?? 20;
  const room = "room-demo";
  const outDir = opts.out ?? fileUrlDir();
  mkdirSync(outDir, { recursive: true });

  let mediaUrl = "", wtHash = "";
  if (opts.media) {
    if (opts.mediahash) { mediaUrl = opts.media; wtHash = opts.mediahash; }
    else {
      const r = await fetch(`${opts.media}/wtcert`);
      const j = (await r.json()) as { url: string; hash: string };
      mediaUrl = j.url; wtHash = j.hash;
    }
  }

  // impairments
  let serverUrl = opts.server;
  let closeChaos: (() => void) | undefined;
  let chaosProc: ChildProcess | undefined;
  if (opts.chaos) {
    const [d, j, p, s] = opts.chaos.split(":").map(Number);
    const proxy = await tcpChaosProxy(new URL(serverUrl), { delay: d, jitter: j, stallP: p, stallMs: s });
    serverUrl = proxy.url;
    closeChaos = proxy.close;
    console.log(`[demo] tcp chaos ${opts.chaos} via ${proxy.url} → ${opts.server}`);
  }
  if (opts.uchaos && mediaUrl) {
    const [d, j, l] = opts.uchaos.split(":").map(Number);
    const uport = 18300 + Math.floor(Math.random() * 500);
    const bin = new URL("../../chaos-udp/chaos-udp", import.meta.url).pathname;
    chaosProc = spawn(bin, [
      "-listen", `127.0.0.1:${uport}`,
      "-upstream", `127.0.0.1:${new URL(mediaUrl).port}`,
      "-delay", String(d), "-jitter", String(j), "-loss", String(l),
    ], { stdio: "ignore" });
    const u = new URL(mediaUrl);
    u.port = String(uport);
    mediaUrl = u.toString();
    console.log(`[demo] udp chaos ${opts.uchaos} via :${uport} → ${new URL(opts.media!).host}`);
  }

  const voices = opts.voices ?? [];
  const { url: clientUrl, close: closeClient } = await serveClient();
  const dash = await serveDashboard(voices);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });

  // recorded context: dashboard only
  for (const f of readdirSync(outDir))
    if (f.startsWith("page@") && f.endsWith(".webm")) rmSync(`${outDir}/${f}`);
  const recCtx: BrowserContext = await browser.newContext({
    recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
  });
  const dashPage = await recCtx.newPage();
  await dashPage.goto(`${dash.url}/`);

  // unrecorded context: the actual VC clients
  const vcCtx = await browser.newContext();
  const pages: Page[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${room}-p${i}`;
    const token = await mintToken(id, room);
    const url = `${clientUrl}/?server=${encodeURIComponent(serverUrl)}&token=${encodeURIComponent(token)}` +
      `&id=${id}&room=${room}&index=${i}&perRoom=${n}&transport=${opts.transport}` +
      (mediaUrl ? `&media=${encodeURIComponent(mediaUrl)}&wthash=${encodeURIComponent(wtHash)}` : "") +
      (opts.audio ? "&record=1" : "") +
      (voices.length ? "&markers=0" : "") +
      (voices[i] ? `&voice=${encodeURIComponent(`${dash.url}/v/${i}.wav`)}` : "");
    const page = await vcCtx.newPage();
    await page.goto(url);
    pages.push(page);
  }

  console.log(`[demo] ${n} clients on ${opts.transport}; recording dashboard ${seconds}s → ${outDir}`);

  // spatial layout (dashboard px space, 700x560): p0/p1 sit close, p2 starts far
  // away (attenuated), then walks in between t=4s..t=16s of the recording.
  const t0 = Date.now();
  const posAt = (ms: number): Record<string, [number, number]> => {
    const k = Math.min(1, Math.max(0, (ms - 11000) / 12000));
    const ease = k * k * (3 - 2 * k);
    return {
      [`${room}-p0`]: [230, 190],
      [`${room}-p1`]: [470, 190],
      [`${room}-p2`]: [640 - 310 * ease, 520 - 220 * ease],
    };
  };
  const GAIN_RADIUS = 180;
  const gainsFor = (self: string, pos: Record<string, [number, number]>) => {
    const [sx, sy] = pos[self];
    return Object.fromEntries(
      Object.entries(pos).filter(([k]) => k !== self)
        .map(([k, [x, y]]) => [k, Math.min(1, GAIN_RADIUS / Math.hypot(x - sx, y - sy))]),
    );
  };

  const recDir = `${outDir}/rec`;
  // stale PCM must not carry across runs — files are appended, so a previous
  // run's data would prepend garbage before this run's audio
  if (opts.audio) {
    rmSync(recDir, { recursive: true, force: true });
    mkdirSync(recDir, { recursive: true });
  }
  let lastDrain = Date.now();
  const ids = pages.map((_, i) => `${room}-p${i}`);
  const drain = async () => {
    for (let i = 0; i < pages.length; i++) {
      try {
        const rec = (await pages[i].evaluate(() =>
          (window as any).__drainRec ? (window as any).__drainRec() : {})) as Record<string, string>;
        for (const [peer, b64] of Object.entries(rec))
          appendFileSync(`${recDir}/${ids[i]}__${peer}.f32`, Buffer.from(b64, "base64"));
      } catch { /* page busy */ }
    }
  };

  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const elapsed = Date.now() - t0;
    const pos = posAt(elapsed);
    const states: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      try {
        const s = await pages[i].evaluate(() => (window as any).__state);
        if (s) states.push(s);
        await pages[i].evaluate((g) => {
          const m = (window as any).__gains;
          if (m?.clear) { m.clear(); for (const [k, v] of Object.entries(g)) m.set(k, v as number); }
        }, gainsFor(ids[i], pos));
      } catch { /* page busy */ }
    }
    try {
      await dashPage.evaluate(([s, pp]) => {
        (window as any).__vc = s; (window as any).__pos = pp;
      }, [states, pos]);
    } catch {}
    if (opts.audio && Date.now() - lastDrain >= 1000) { lastDrain = Date.now(); await drain(); }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (opts.audio) await drain();

  // close recorded context first so the video flushes
  await recCtx.close();
  await vcCtx.close();
  await browser.close();
  dash.close();
  closeClient();
  closeChaos?.();
  chaosProc?.kill();

  const videos = readdirSync(outDir)
    .filter((f) => f.startsWith("page@") && f.endsWith(".webm") &&
      statSync(`${outDir}/${f}`).size > 0)
    .sort();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const [i, v] of videos.entries()) {
    const name = `vc-demo-${opts.transport}-${stamp}${i ? `-${i}` : ""}.webm`;
    renameSync(`${outDir}/${v}`, `${outDir}/${name}`);
    console.log(`[demo] ${outDir}/${name}`);
  }

  // audio: mix what the first client (listener) hears → mux into the video
  if (opts.audio && videos.length) {
    const listener = ids[0];
    let streams = readdirSync(recDir).filter((f) => f.startsWith(`${listener}__`));
    if (opts.self === false) streams = streams.filter((f) => !f.endsWith("__self.f32"));
    if (!streams.length) {
      console.log("[demo] no recorded audio — skipping mux");
      return;
    }
    const mixWav = `${outDir}/mix-${stamp}.wav`;
    const ins = streams.flatMap((f) => ["-f", "f32le", "-ar", "48000", "-ac", "1", "-i", `${recDir}/${f}`]);
    const amix = streams.map((_, k) => `[${k}]`).join("") +
      `amix=inputs=${streams.length}:normalize=0,volume=${Math.min(streams.length, 1.5)},alimiter=limit=0.9`;
    execFileSync("ffmpeg", ["-y", "-v", "error", ...ins, "-filter_complex", amix, mixWav]);
    const base = `vc-demo-${opts.transport}-${stamp}.webm`;
    const finalName = `vc-demo-${opts.transport}-${stamp}-audio.webm`;
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-i", `${outDir}/${base}`, "-i", mixWav,
      "-c:v", "copy", "-c:a", "libopus", "-shortest", `${outDir}/${finalName}`,
    ]);
    console.log(`[demo] ${outDir}/${finalName} (audio: ${streams.join(", ")})`);
    // dropout report: silences ≥150ms below -45dB in the recorded mix
    const sd = spawnSync("ffmpeg", ["-v", "info", "-i", mixWav,
      "-af", "silencedetect=noise=-45dB:d=0.15", "-f", "null", "-"], { encoding: "utf8" });
    const serr = sd.stderr ?? "";
    const durs = [...serr.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
    const long = durs.filter((d) => d >= 0.15);
    console.log(`[demo] dropouts: ${long.length}${long.length ? " (" + long.slice(0, 10).map((d) => d.toFixed(2) + "s").join(", ") + (long.length > 10 ? "…" : "") + ")" : ""}`);
  }
}

// three.js WebGPU world demo: the recorded page IS a real VC client (p0) inside
// the 3D scene — WASD/auto-pilot movement, avatars, distance attenuation. Other
// participants are headless bench clients with ?pos= anchors + voice wavs; all
// position sharing flows over the real signaling channel as {pos} signals.
export async function demoWorld(opts: {
  server: string; transport: string; clients?: number; seconds?: number; out?: string;
  media?: string; mediahash?: string; voices?: string[]; audio?: boolean; self?: boolean;
}) {
  const n = opts.clients ?? 3;
  const seconds = opts.seconds ?? 24;
  const room = "room-world";
  const outDir = opts.out ?? fileUrlDir();
  mkdirSync(outDir, { recursive: true });

  let mediaUrl = "", wtHash = "";
  if (opts.media) {
    if (opts.mediahash) { mediaUrl = opts.media; wtHash = opts.mediahash; }
    else {
      const r = await fetch(`${opts.media}/wtcert`);
      const j = (await r.json()) as { url: string; hash: string };
      mediaUrl = j.url; wtHash = j.hash;
    }
  }

  const voices = opts.voices ?? [];
  const { url: clientUrl, close: closeClient } = await serveClient();
  const dash = await serveDashboard(voices);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
    ],
  });

  // layout in world units (hearing radius = 30): p1 near, p2 far to start
  const peerPos: Record<string, [number, number]> = {
    [`${room}-p1`]: [8, 6],
    [`${room}-p2`]: [55, 30],
    [`${room}-p3`]: [-40, 45],
  };
  // p0 scripted route: far corner -> near p1 -> close to p2 -> back away
  const autoPath = "-60,-40;6,3;52,27;52,27;0,-40";

  // clear stale page@*.webm captures left by crashed runs — must happen before
  // the recorded context is created or we'd unlink live recordings
  for (const f of readdirSync(outDir))
    if (f.startsWith("page@") && f.endsWith(".webm")) rmSync(`${outDir}/${f}`);

  const recCtx: BrowserContext = await browser.newContext({
    recordVideo: { dir: outDir, size: { width: 960, height: 600 } },
    viewport: { width: 960, height: 600 },
  });

  const clientQuery = (i: number) => {
    const id = `${room}-p${i}`;
    return {
      id,
      q: `server=${encodeURIComponent(opts.server)}&id=${id}&room=${room}` +
        `&index=${i}&perRoom=${n}&transport=${opts.transport}` +
        (mediaUrl ? `&media=${encodeURIComponent(mediaUrl)}&wthash=${encodeURIComponent(wtHash)}` : "") +
        (opts.audio ? "&record=1" : "") +
        (voices.length ? "&markers=0" : "") +
        "&framedur=40" +
        (peerPos[id] ? `&pos=${peerPos[id][0]},${peerPos[id][1]}` : "") +
        (voices[i] ? `&voice=${encodeURIComponent(`${dash.url}/v/${i}.wav`)}` : "&nomic=1"),
    };
  };

  // p0: the recorded 3D world page (a real client)
  const { id: id0, q: q0 } = clientQuery(0);
  const worldPage = await recCtx.newPage();
  const token0 = await mintToken(id0, room);
  await worldPage.goto(`${clientUrl}/world?${q0}&token=${encodeURIComponent(token0)}&pos=-60,-40&auto=1&path=${encodeURIComponent(autoPath)}&gl=1&fps=24&autojoin=1`);
  // let p0's page finish its startup burst (renderer init, video capture,
  // transport connect+announce) before spawning peers — under load the
  // world page's event loop starves for ~10s and late-joining peers would
  // otherwise sit unsubscribed through the whole recording
  await worldPage
    .waitForFunction(() => (window as any).__state != null, undefined, { timeout: 30000 })
    .catch(() => console.log("[demo] warn: world page __state timeout"));
  await new Promise((r) => setTimeout(r, 1500));

  // p1..: headless bench clients with anchors + voices
  const vcCtx = await browser.newContext();
  const pages: Page[] = [];
  for (let i = 1; i < n; i++) {
    const { id, q } = clientQuery(i);
    const token = await mintToken(id, room);
    const page = await vcCtx.newPage();
    await page.goto(`${clientUrl}/bench?${q}&token=${encodeURIComponent(token)}`);
    pages.push(page);
  }

  console.log(`[demo] world page + ${n - 1} headless clients on ${opts.transport}; recording ${seconds}s → ${outDir}`);

  const recDir = `${outDir}/rec`;
  // clear leftovers — see note in the dashboard variant
  if (opts.audio) {
    rmSync(recDir, { recursive: true, force: true });
    mkdirSync(recDir, { recursive: true });
  }
  const drain = async () => {
    try {
      const rec = (await worldPage.evaluate(() =>
        (window as any).__drainRec ? (window as any).__drainRec() : {})) as Record<string, string>;
      for (const [peer, b64] of Object.entries(rec))
        appendFileSync(`${recDir}/${id0}__${peer}.f32`, Buffer.from(b64, "base64"));
    } catch { /* page busy */ }
  };

  let ticks = 0;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (opts.audio) await drain();
    if (++ticks % 5 === 0) {
      try {
        const st = (await worldPage.evaluate(() => (window as any).__state)) as {
          stats?: Record<string, unknown>[];
        };
        const r = st?.stats?.[0] ?? {};
        console.log(
          `[demo] p0 sent=${r["sent_frames"]} recv=${r["recv_frames"]} ` +
            `fed=${r["dec_fed"]} decq=${r["dec_queue"]} ` +
            `levels=${JSON.stringify(r["levels"] ?? {})}`,
        );
      } catch { /* page busy */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (opts.audio) await drain();

  await recCtx.close();
  await vcCtx.close();
  await browser.close();
  dash.close();
  closeClient();

  const videos = readdirSync(outDir)
    .filter((f) => f.startsWith("page@") && f.endsWith(".webm") &&
      statSync(`${outDir}/${f}`).size > 0)
    .sort();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const [i, v] of videos.entries()) {
    const name = `vc-world-${opts.transport}-${stamp}${i ? `-${i}` : ""}.webm`;
    renameSync(`${outDir}/${v}`, `${outDir}/${name}`);
    console.log(`[demo] ${outDir}/${name}`);
  }

  if (opts.audio && videos.length) {
    let streams = readdirSync(recDir).filter((f) => f.startsWith(`${id0}__`));
    if (opts.self === false) streams = streams.filter((f) => !f.endsWith("__self.f32"));
    if (!streams.length) {
      console.log("[demo] no recorded audio — skipping mux");
      return;
    }
    const mixWav = `${outDir}/mix-${stamp}.wav`;
    const ins = streams.flatMap((f) => ["-f", "f32le", "-ar", "48000", "-ac", "1", "-i", `${recDir}/${f}`]);
    const amix = streams.map((_, k) => `[${k}]`).join("") +
      `amix=inputs=${streams.length}:normalize=0,volume=${Math.min(streams.length, 1.5)},alimiter=limit=0.9`;
    execFileSync("ffmpeg", ["-y", "-v", "error", ...ins, "-filter_complex", amix, mixWav]);
    const base = `vc-world-${opts.transport}-${stamp}.webm`;
    const finalName = `vc-world-${opts.transport}-${stamp}-audio.webm`;
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-i", `${outDir}/${base}`, "-i", mixWav,
      "-c:v", "copy", "-c:a", "libopus", "-shortest", `${outDir}/${finalName}`,
    ]);
    console.log(`[demo] ${outDir}/${finalName} (audio: ${streams.join(", ")})`);
  }
}

function fileUrlDir() {
  const here = new URL("../", import.meta.url).pathname;
  return `${here}demo`;
}
