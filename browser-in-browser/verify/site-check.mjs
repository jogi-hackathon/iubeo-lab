// 汎用サイト生存チェック: URL へ遷移し 20s 後にエンジン生存+DOM状態を報告。
// SITE=<url> ENGINE=vcb DEPTHCAP=<n> ENVS="K=V&K2=V2" node verify/site-check.mjs
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const SITE = process.env.SITE ?? 'https://thirdlf03.com/'
const WAIT_MS = Number(process.env.WAIT_MS ?? 20_000)
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHCAP ?? '350000')
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]') && /error|Error|InternalError|RangeError|xrefuse|wj-sus/i.test(t))
    console.log(`  ${t.slice(0, 300)}`)
})
page.on('pageerror', (e) => { errs.push(e.message); console.log(`  pageerror: ${e.message}`) })

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

console.log(`  navigate: ${SITE}`)
await page.evaluate((u) => window.bib.source.navigate(u), SITE)
await page.waitForTimeout(WAIT_MS)
const s = await evalIn(`JSON.stringify({
  rs: document.readyState,
  title: document.title.slice(0, 80),
  bodyLen: document.body ? document.body.innerText.length : -1,
  links: document.querySelectorAll('a').length,
  inputs: document.querySelectorAll('input').length,
})`)
console.log(`  state: ${s}`)
const slug = SITE.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
await page.screenshot({ path: `${OUT}/site-${slug}.png` })
await browser.close()
