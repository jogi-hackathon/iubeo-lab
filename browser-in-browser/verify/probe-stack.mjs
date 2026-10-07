// gecko.js 内側の JS で plain recursion / host-boundary recursion の実効深度を測る
import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'vcb'
const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log('status=', await page.evaluate(() => window.bib?.source?.status))
const evalIn = (js) => page.evaluate(async (src) => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return 'no engine'
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((r) => setTimeout(() => r('T/O'), 15000))])
}, js)
await page.evaluate(() => window.bib.source.navigate('about:blank'))
await page.waitForTimeout(3000)
const r = await evalIn(`(() => {
  function g(n){ return n<=0?0:g(n-1)+1 }
  var arr=[0]; function m(n){ if(n<=0)return 0; return arr.map(function(){return m(n-1)})[0]+1 }
  function mx(fn){ var lo=0,hi=200000; while(lo+1<hi){var mid=(lo+hi)>>1; try{fn(mid);lo=mid}catch(e){hi=mid}} return lo }
  return JSON.stringify({plain: mx(g), host: mx(m)})
})()`)
console.log('result:', r)
await browser.close()
