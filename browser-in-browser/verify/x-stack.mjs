// sentry-filter の InternalError スタックを取る — 何が再帰してるか特定する。
// error イベントの e.error.stack を確保（フックは遷移後に入れるので、
// 発生済みエラーは拾えない。代わりに console 側の "JavaScript error" 全文を取得）
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHCAP ?? '350000')
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
// フィルタなし全量 — recursion の前後の文脈を見る
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]')) console.log(`  ${t.slice(0, 400)}`)
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

const evalIn = (js) =>
  page.evaluate(async (src) => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    return Promise.race([
      eng.run({ op: 5, url: src }),
      new Promise((res) => setTimeout(() => res('EVAL_TIMEOUT'), 12_000)),
    ])
  }, js)

console.log('  onboarding へ直接遷移…')
await page.evaluate(() =>
  window.bib.source.navigate('https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2F'))

// 20s 後に一度だけ深掘り: 例外状態 + 生きてるグローバル
await page.waitForTimeout(20_000)
const s = await evalIn(`JSON.stringify({
  rs: document.readyState,
  bodyLen: document.body.innerText.length,
  inputs: document.querySelectorAll('input').length,
})`)
console.log(`  state: ${s}`)
await page.screenshot({ path: `${OUT}/x-stack.png` })
await browser.close()
