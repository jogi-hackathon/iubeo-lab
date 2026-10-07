// onboarding 直接遷移で mount 失敗の実態を掴む: DOM 中身・script ロード状況・例外を詳細ダンプ
import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.9-inloop'
const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)
const browser = await chromium.launch({
  channel: 'chrome',
  args: process.env.JSFLAGS ? [`--js-flags=${process.env.JSFLAGS}`] : [],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const geckoLog = []
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]')) { geckoLog.push(t); console.log(`  ${t.slice(0, 200)}`) }
})
page.on('pageerror', (e) => console.log('  pageerror:', e.message.slice(0, 150)))
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
  if (!eng?.run) return 'no engine'
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((r) => setTimeout(() => r('T/O'), 30000))])
}, js)

await page.evaluate(() => window.bib.source.navigate('https://x.com/i/jf/onboarding/web?mode=signup&redirect_after_login=%2F'))
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000)
  const s = await evalIn(`JSON.stringify({
    rs: document.readyState, bodyLen: document.body ? document.body.innerText.length : -1,
    htmlLen: document.body ? document.body.innerHTML.length : -1,
    scripts: document.scripts.length,
    divs: document.querySelectorAll('div').length,
    inputs: document.querySelectorAll('input').length,
    rootKids: document.getElementById('react-root') ? document.getElementById('react-root').childElementCount : 'none',
    resources: performance.getEntriesByType('resource').length,
    onDemand: performance.getEntriesByType('resource').filter(e=>e.name.includes('ondemand')).length,
  })`)
  console.log(`  [${i * 5}s] ${s}`)
}
// エラーイベントを仕込み直してみる（遅ればせながら window.onerror で過去分は取れないが以降を捕捉）
const diag = await evalIn(`JSON.stringify({
  title: document.title,
  bodyHTML: (document.body?.innerHTML||'').slice(0,500),
  lastResources: performance.getEntriesByType('resource').slice(-8).map(e=>e.name.slice(-60)),
})`)
console.log('  diag:', diag)
await page.screenshot({ path: 'verify/shots/onboard-diag.png' })
await browser.close()
