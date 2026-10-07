import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5199'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const params = new URLSearchParams({ wisp: 'ws://127.0.0.1:5001/', engine: 'vcb' })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
for (const kv of (process.env.EXTRA_ENV ?? '').split(',')) if (kv) params.set('env.' + kv, '1')
for (const kv of (process.env.EXTRA_ENVV ?? '').split(',')) if (kv) { const [k, v] = kv.split('='); params.set('env.' + k, v) }
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('[wj-xrefuse]') || t.includes('[wj-sus]') || t.includes('too much recursion') || t.includes('RangeError') || t.includes('Maximum call')) console.log(`  ${t.slice(0, 200)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
const evalIn = (js) => page.evaluate(async (src) => {
  const eng = window.bib?.source?.engine
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((res) => setTimeout(() => res('EVAL_TIMEOUT'), 10_000))])
}, js)
await page.evaluate(() => window.bib.source.navigate('https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2F'))
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(12000)
  const s = await evalIn(`JSON.stringify({rs:document.readyState,bodyLen:document.body?document.body.innerText.length:-1,inputs:document.querySelectorAll('input').length,buttons:document.querySelectorAll('button').length})`)
  console.log(`  [t+${(i+1)*12}s] ${s}`)
}
await browser.close()
