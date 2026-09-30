// プロジェクト内 wisp（npm run wisp）経由で thirdlf03.com が開けるか実機確認。
// 結果は verify/shots/20-thirdlf03.png に保存する。
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/?wisp=ws://127.0.0.1:5001/'
const TARGET = process.env.TARGET_URL ?? 'https://thirdlf03.com/'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
const geckoLog = []
page.on('console', (m) => {
  const text = m.text()
  if (m.type() === 'error') errors.push(text)
  if (text.startsWith('[gecko]')) geckoLog.push(text.replace('[gecko] ', ''))
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(500)

await page.locator('.hud__source', { hasText: 'Gecko' }).click()
const t0 = Date.now()
let status = ''
for (;;) {
  status = await page.evaluate(() => window.bib.source.status)
  if (status === 'ready' || status === 'error' || status === 'unavailable') break
  if (Date.now() - t0 > 300_000) break
  await page.waitForTimeout(1000)
}
console.log(`boot: ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (status !== 'ready') {
  console.log('FAIL: エンジン起動せず', errors.slice(0, 5).join('\n'))
  await browser.close()
  process.exit(1)
}

const errBefore = errors.length
await page.evaluate((url) => window.bib.source.navigate(url), TARGET)

const deadline = Date.now() + 90_000
let outcome = 'timeout'
for (;;) {
  const tail = geckoLog.slice(-8).join('\n')
  if (/load stop status=0x00000000/.test(tail)) { outcome = 'loaded'; break }
  if (/load FAILED status=0x80004005/.test(tail) || /Networking error/i.test(tail)) { outcome = 'failed'; break }
  if (Date.now() > deadline) break
  await page.waitForTimeout(500)
}

// 描画後のフレームを落ち着かせる
await page.waitForTimeout(outcome === 'loaded' ? 6000 : 1500)
await page.screenshot({ path: `${OUT}/20-thirdlf03.png` })

const stats = await page.evaluate(() => {
  const canvas = document.getElementById('screen')
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let nonBlack = 0
  const seen = new Set()
  for (let i = 0; i < data.length; i += 4 * 97) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r + g + b > 24) nonBlack += 1
    seen.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4))
  }
  return { nonBlack, colors: seen.size }
})

const related = geckoLog.filter((l) => /networking disabled|load (FAILED|stop)|LoadURI|Failed to open/i).slice(-10)
console.log('関連ログ:')
for (const line of related) console.log(`  ${line}`)
console.log(`outcome=${outcome} 描画=${JSON.stringify(stats)} 新規エラー=${errors.length - errBefore} 件`)
console.log('スクリーンショット: verify/shots/20-thirdlf03.png')

const networkingDisabled = geckoLog.some((l) => /networking disabled/.test(l))
const pass = outcome === 'loaded' && !networkingDisabled && stats.nonBlack > 1000
console.log(pass ? 'PASS: thirdlf03.com が自前 wisp 経由で描画された' : 'FAIL')
await browser.close()
process.exit(pass ? 0 : 1)