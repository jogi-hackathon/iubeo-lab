// per-site PBL フォールバックの切り替わり検証。
//   x.com       -> pin 作動 (wjPinTimer 生、limit=1 なので [wj-depth3] が出る)
//   別サイトへ   -> pin 解除 (wjPinTimer 消、limit 復帰で depth3 が止まる)
//   x.com へ戻る -> pin 再作動
//
//   NO_DEPTHCAP=1 node verify/x-pbl-toggle.mjs
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const NORMAL = process.env.NORMAL_SITE ?? 'https://thirdlf03.com/'

const params = new URLSearchParams({ wisp: WISP })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
params.set('env.GECKO_WJ_DEPTHDBG', '1')

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let depth3 = 0
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('[wj-depth3]')) depth3++
  if (t.startsWith('[gecko]') && /InternalError|too much recursion/.test(t))
    console.log(`  ${t.slice(0, 140)}`)
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
console.log(`engine: ${status}`)
if (status !== 'ready') process.exit(1)

const nav = (u) => page.evaluate((x) => window.bib.source.navigate(x), u)
const dom = () =>
  page.evaluate(async () => {
    try {
      return await window.bib.source.engine.run({
        op: 5,
        url: `JSON.stringify({rs:document.readyState,loc:location.host,body:document.body?document.body.innerText.length:-1})`,
      })
    } catch { return null }
  })
const pinState = () =>
  page.evaluate(() => ({
    pblOnly: window.bib.source.pblOnly,
    pin: window.bib.source.wjPinTimer !== undefined,
  }))

const phase = async (label, url, secs) => {
  console.log(`\n=== ${label}: ${url}`)
  await nav(url)
  const end = Date.now() + secs * 1000
  const d0 = depth3
  while (Date.now() < end) {
    await page.waitForTimeout(2000)
    const s = await dom()
    if (s) console.log(`  ${JSON.stringify(s)} pin=${JSON.stringify(await pinState())}`)
  }
  console.log(`  depth3 logs in phase: ${depth3 - d0} (total ${depth3})`)
}

await phase('x.com onboarding', 'https://x.com/i/jf/onboarding/web?mode=signup', 25)
await phase('normal site', NORMAL, 15)
await phase('back to x.com', 'https://x.com/', 15)
await browser.close()
