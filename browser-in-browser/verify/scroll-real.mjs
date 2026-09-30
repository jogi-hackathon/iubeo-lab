// 決定打テスト: 静かな実サイト（textfiles.com = JS無し・長い静的HTML）で、
// 現エンジンが「実サイトのスクロール」をできるのかを evalChrome + wheel で確かめる。
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
await page.goto('http://localhost:4173/probe.html?wisp=ws://127.0.0.1:5001/', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.__probe, null, { timeout: 120_000 })
console.log('boot OK')

const evalChrome = (js) =>
  page.evaluate(
    (code) => Promise.race([
      window.__probe.eval(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), 30000)),
    ]),
    js,
  ).catch((e) => 'ERR:' + String(e).slice(0, 80))

const digest = () => page.evaluate(() => {
  const c = document.getElementById('screen')
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
  let s = 0, n = 0, colors = new Set()
  for (let i = 0; i < data.length; i += 4 * 11) {
    s += data[i] + data[i + 1] + data[i + 2]
    colors.add((data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4))
    n++
  }
  return { avg: Math.round(s / n / 3), colors: colors.size }
})

// エンジンの canvas リスナー（attachInput）に直に wheel を投げる = アプリと同じ OP_WHEEL 経路
const sendWheel = (dy) => page.evaluate((w) => {
  const canvas = document.getElementById('screen')
  const r = canvas.getBoundingClientRect()
  canvas.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, composed: true, deltaY: w, deltaMode: 0,
    clientX: r.left + 480, clientY: r.top + 360,
  }))
}, dy)

await page.evaluate((u) => { void window.__probe.load(u) }, 'https://textfiles.com/bbs/')
console.log('textfiles.com/bbs ロード後 25s 待機…')
await page.waitForTimeout(25000)

const m1 = await evalChrome(
  'JSON.stringify({h:document.scrollingElement.scrollHeight,c:document.scrollingElement.clientHeight,t:document.scrollingElement.scrollTop,title:(document.title||"").slice(0,30)})')
console.log('① metrics:', m1)

if (m1.startsWith('ERR')) {
  console.log('eval が回らない（ページが重い/ロード失敗）。canvas 状態だけ確認:')
  console.log('  digest:', JSON.stringify(await digest()))
  await browser.close()
  process.exit(0)
}
const { h } = JSON.parse(m1.slice(1, -1))
if (h <= 720) {
  console.log('h <= 720: このページはスクロール不要（もしくはエラーページ）')
  await browser.close()
  process.exit(0)
}

await sendWheel(500)
await page.waitForTimeout(2000)
const t2 = await evalChrome('String(document.scrollingElement.scrollTop)')
const d0 = await digest()
console.log('② wheel(500) 後 scrollTop:', t2)
await sendWheel(-300)
await page.waitForTimeout(2000)
const t3 = await evalChrome('String(document.scrollingElement.scrollTop)')
const d1 = await digest()
console.log('③ wheel(-300) 後 scrollTop:', t3)
console.log('④ canvas digest 変化:', JSON.stringify(d0), '→', JSON.stringify(d1))

const moved = t2 !== '0' && t2 !== t3 && !String(t2).startsWith('ERR') && !String(t3).startsWith('ERR')
const painted = JSON.stringify(d0) !== JSON.stringify(d1)
console.log(`判定: スクロール可能=${moved}（wheel で位置が動いた） 再描画=${painted}`)
await browser.close()