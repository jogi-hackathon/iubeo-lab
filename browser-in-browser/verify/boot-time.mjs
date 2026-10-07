// エンジン起動時間の計測: ENGINE=vcb|vcb-raw node verify/boot-time.mjs
// booting->ready の実測 + 画面表示までの時間を報告する。
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5199'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'vcb'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
const t0 = Date.now()
await page.goto(`${BASE}/?wisp=${encodeURIComponent(WISP)}&engine=${ENGINE}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const tClick = Date.now() - t0
let status = '?'
while (Date.now() - t0 < 300_000) {
  status = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (status === 'ready' || status === 'error') break
  await page.waitForTimeout(500)
}
const tReady = Date.now() - t0
console.log(`engine=${ENGINE} ui=${tClick}ms ready=${tReady}ms status=${status}`)
await browser.close()
