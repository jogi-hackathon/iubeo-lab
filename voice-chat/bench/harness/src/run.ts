import { chromium } from "playwright";
import { mkdirSync, createWriteStream, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintToken } from "./keys.ts";
import { serveClient } from "./serveClient.ts";
import { aggregate, fmtSummary, type RawReport } from "./report.ts";

type Scenario = { name: string; rooms: number; perRoom: number; warmupS: number; durationS: number };

export async function run(opts: { scenario: string; transport: string; server: string; browsers?: number; media?: string; mediahash?: string; clientParams?: string }) {
  const scenPath = fileURLToPath(new URL(`../../scenarios/${opts.scenario}.json`, import.meta.url));
  const scen: Scenario = JSON.parse(readFileSync(scenPath, "utf8"));
  const total = scen.rooms * scen.perRoom;
  console.log(`[harness] scenario=${scen.name} transport=${opts.transport} rooms=${scen.rooms}x${scen.perRoom} (${total} clients) server=${opts.server}`);

  const runDir = fileURLToPath(new URL(`../../results/${Date.now()}-${scen.name}-${opts.transport}/`, import.meta.url));
  mkdirSync(runDir, { recursive: true });
  const metricsStream = createWriteStream(runDir + "metrics.jsonl");
  const serverStream = createWriteStream(runDir + "server-metrics.jsonl");
  const reports: RawReport[] = [];

  const { url: clientUrl, close: closeHttp } = await serveClient();

  // Shard clients across N browser processes — one process saturates CPU around
  // ~10-30 AudioContexts. Separate processes still share the machine clock, so
  // epoch-based latency correlation stays valid.
  const nBrowsers = Math.max(1, opts.browsers ?? Math.ceil(total / 10));
  const browsers = await Promise.all(
    Array.from({ length: nBrowsers }, () =>
      chromium.launch({
        headless: true,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--use-fake-ui-for-media-stream",
          "--disable-features=WebRtcHideLocalIpsWithMdns",
        ],
      }),
    ),
  );
  console.log(`[harness] ${nBrowsers} browser process(es)`);

  const base = opts.server.replace(/^http/, "ws");
  const serverHttp = base.replace(/^ws/, "http");
  const serverRows: { ts: number; data: unknown }[] = [];

  // media relays (wt-datagram/moq) advertise their WT URL + cert hash via /wtcert;
  // relays without a /wtcert shim (moq-relay) take --mediahash directly.
  let mediaUrl = "";
  let wtHash = "";
  if (opts.media) {
    if (opts.mediahash) {
      mediaUrl = opts.media;
      wtHash = opts.mediahash;
    } else {
      const r = await fetch(`${opts.media}/wtcert`);
      if (!r.ok) throw new Error(`media relay /wtcert: HTTP ${r.status}`);
      const j = (await r.json()) as { url: string; hash: string };
      mediaUrl = j.url;
      wtHash = j.hash;
    }
    console.log(`[harness] media relay ${mediaUrl} cert sha256=${wtHash.slice(0, 16)}…`);
  }

  // poll server /metrics at 1Hz (+ media relay /metrics if given)
  const poll = setInterval(async () => {
    for (const u of [serverHttp, opts.mediahash ? undefined : opts.media].filter(Boolean) as string[]) {
      try {
        const r = await fetch(`${u}/metrics`);
        const data = await r.json();
        const row = { ts: Date.now(), url: u, data };
        serverRows.push(row);
        serverStream.write(JSON.stringify(row) + "\n");
      } catch {}
    }
  }, 1000);

  const t0 = Date.now();
  const pages = [];
  try {
    // spawn all clients; distribute round-robin across browser processes
    for (let r = 0; r < scen.rooms; r++) {
      const room = `room-${r}`;
      const roomPages = await Promise.all(
        Array.from({ length: scen.perRoom }, async (_, i) => {
          const id = `${room}-p${i}`;
          const browser = browsers[(r * scen.perRoom + i) % browsers.length];
          const page = await browser.newPage();
          await page.exposeFunction("__report", (batch: RawReport[]) => {
            for (const rep of batch) {
              reports.push(rep);
              metricsStream.write(JSON.stringify(rep) + "\n");
            }
          });
          const token = await mintToken(id, room);
          const url = `${clientUrl}/bench?server=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}&id=${id}&room=${room}&index=${i}&perRoom=${scen.perRoom}&transport=${opts.transport}` +
            (mediaUrl ? `&media=${encodeURIComponent(mediaUrl)}&wthash=${encodeURIComponent(wtHash)}` : "") +
            (opts.clientParams ? `&${opts.clientParams}` : "");
          await page.goto(url);
          return page;
        }),
      );
      pages.push(...roomPages);
    }
    console.log(`[harness] ${pages.length} clients joined; warmup ${scen.warmupS}s + measure ${scen.durationS}s`);

    await new Promise((r) => setTimeout(r, (scen.warmupS + scen.durationS) * 1000));
  } finally {
    clearInterval(poll);
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
    closeHttp();
    metricsStream.end();
    serverStream.end();
  }

  const warmupUntil = t0 + scen.warmupS * 1000;
  const summary = aggregate(reports, serverRows, warmupUntil);
  const out = { scenario: scen.name, transport: opts.transport, server: opts.server, clients: total, browsers: nBrowsers, warmup_s: scen.warmupS, duration_s: scen.durationS, summary };
  writeFileSync(runDir + "summary.json", JSON.stringify(out, null, 2));
  console.log(`\n=== ${scen.name} / ${opts.transport} ===\n${fmtSummary(summary)}\n→ ${runDir}`);
}
