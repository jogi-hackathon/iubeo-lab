// 判別テスト: _wj_set_depth_limit(1) をロード中も定期再適用して、
// wjProbeStack（pthread 側 Module 経由なので mod ラッパーを素通りする）の
// キャリブ上書きが set(1) 無効化の原因かどうかを切り分ける。
//
//   node verify/x-pin-test.mjs
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const TARGET = process.env.SITE ?? 'https://x.com/i/jf/onboarding/web?mode=signup&redirect_after_login=%2F'
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 45_000)

const params = new URLSearchParams({ wisp: WISP })
params.set('env.GECKO_CONTENT_CONSOLE', '1')

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]') && /InternalError|error|depth/i.test(t))
    console.log(`  ${t.slice(0, 160)}`)
})

await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(1500)
await page.click('.hud__source >> nth=1')

const t0 = Date.now()
let status = 'booting'
while (Date.now() - t0 < 240_000) {
  status = await page.evaluate(() => window.bib.source.status)
  if (status !== 'booting' && status !== 'idle') break
  await page.waitForTimeout(1000)
}
console.log(`engine: ${status} (${Math.round((Date.now() - t0) / 1000)}s)`)
if (status !== 'ready') process.exit(1)

// 250ms 毎に set(1) を再アサート。probe が worker 側で上書きしても即座に潰す。
// APP_PIN_ONLY=1 では入れず、アプリ側（GeckoSource）のピン留めだけを検証する。
if (!process.env.APP_PIN_ONLY) {
  await page.evaluate(() => {
    const eng = window.bib.source.engine
    window.__wjPin = setInterval(() => {
      try { eng.mod._wj_set_depth_limit(1) } catch {}
    }, 250)
  })
}

await page.evaluate((u) => window.bib.source.navigate(u), TARGET)

const evalIn = (js) =>
  page.evaluate(async (src) => {
    try { return await window.bib.source.engine.run({ op: 5, url: src }) }
    catch (e) { return `evalerr:${e.message}` }
  }, js)

const seen = []
let lastSig = ''
while (Date.now() - t0 < OBSERVE_MS) {
  const s = await evalIn(`JSON.stringify({
    rs: document.readyState, loc: location.href.slice(0,80),
    bodyLen: document.body ? document.body.innerText.length : -1,
    htmlLen: document.body ? document.body.innerHTML.length : -1,
    divs: document.querySelectorAll('div').length,
    inputs: document.querySelectorAll('input').length,
  })`)
  if (s !== lastSig) {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
    seen.push(s)
    lastSig = s
  }
  await page.waitForTimeout(1500)
}
await page.evaluate(() => window.__wjPin && clearInterval(window.__wjPin))
console.log('final:', seen.at(-1))
await browser.close()
