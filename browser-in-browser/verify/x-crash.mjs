// x.com でエンジンが落ちる問題の切り分けプローブ。
//
//   node verify/patch-werr.mjs v0.0.6   # 先にエンジンコピーへ計装
//   npm run dev + npm run wisp 起動後:
//   node verify/x-crash.mjs
//
// 観測:
//   - Worker 作成時系列（em-pthread プール外の遅発 spawn = Gecko が立てた新規
//     スレッド = content Worker の可能性）
//   - [werr] で pthread 内 unhandledrejection の真のスタック
//   - クラッシュ後に putImageData / eval が生きてるか（app-main 死亡判定）
//   - page.workers() の推移
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const SITE = process.env.SITE ?? 'https://x.com'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

// エンジン起動前に Worker を包んで作成順を記録する
await page.addInitScript(() => {
  const Orig = window.Worker
  window.__wcr = []
  let idx = 0
  window.Worker = class extends Orig {
    constructor(url, opts) {
      super(url, opts)
      const rec = { i: idx++, t: performance.now(), url: String(url).slice(0, 80) }
      window.__wcr.push(rec)
      this.addEventListener('error', (e) => {
        console.log(
          `[widx#${rec.i}] ERROR created@+${Math.round(rec.t)}ms ${e.filename}:${e.lineno} ${e.message}`,
        )
      })
    }
  }
})

page.on('console', (m) => {
  const t = m.text()
  if (
    t.includes('[gecko]') ||
    t.includes('[werr]') ||
    t.includes('[widx') ||
    /error|fail|Pthread/i.test(t)
  )
    console.log(`  ${t.slice(0, 400)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')

const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log(`  status: ${await page.evaluate(() => window.bib?.source?.status)}`)
console.log(
  `  workers after boot: ${await page.evaluate(() => JSON.stringify(window.__wcr.map((w) => w.i)))}`,
)

// putImageData 回数を計装（app スレッド生存の指標）
await page.evaluate(() => {
  const c = document.getElementById('screen')
  const ctx = c.getContext('2d')
  if (ctx && !ctx.__probe) {
    ctx.__probe = true
    const orig = ctx.putImageData.bind(ctx)
    window.__puts = 0
    ctx.putImageData = (...a) => {
      window.__puts++
      return orig(...a)
    }
  }
})

console.log(`  navigating: ${SITE}`)
await page.evaluate((u) => window.bib.source.navigate(u), SITE)

const t0 = Date.now()
let deadAt = -1
while (Date.now() - t0 < 180_000) {
  const r = await page.evaluate(async () => {
    const eng = window.bib?.source?.engine
    const p = eng?.run
      ? Promise.race([
          eng.run({ op: 5, url: 'JSON.stringify({rs:document.readyState,t:document.title})' }),
          new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000)),
        ])
      : Promise.resolve('no engine')
    return {
      eval: await p,
      puts: window.__puts ?? -1,
      workers: window.__wcr.length,
      nw: window.__wcr.slice(-4),
    }
  })
  const el = ((Date.now() - t0) / 1000).toFixed(0)
  console.log(
    `  [${el}s] eval=${JSON.stringify(r.eval).slice(0, 140)} puts=${r.puts} workers=${r.workers} last=${JSON.stringify(r.nw)}`,
  )
  if (r.eval === 'TIMEOUT' || r.eval === null) {
    if (deadAt < 0) deadAt = el
  }
  await page.waitForTimeout(5000)
}
console.log(`  eval dead at ~${deadAt}s`)
await page.screenshot({ path: `${OUT}/x-crash.png` })
await browser.close()
