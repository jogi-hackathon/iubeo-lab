import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'vcb'
const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  pageerror:', e.message.slice(0, 120)))
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
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((r) => setTimeout(() => r('T/O'), 60000))])
}, js)
await page.evaluate(() => window.bib.source.navigate('about:blank'))
await page.waitForTimeout(2000)
const r = await evalIn(`(() => {
  function deep(n){ var o={}; for(var i=0;i<n;i++) o={c:o}; return o }
  function mx(f,h){ var lo=0,hi=h; while(lo+1<hi){var mid=(lo+hi)>>1; try{f(mid);lo=mid}catch(e){hi=mid}} return lo }
  var out={}
  try{ out.jsonStr = mx(n=>JSON.stringify(deep(n)), 50000) }catch(e){ out.jsonStr='crash?' }
  try{ out.jsonParse = mx(n=>JSON.parse(deep(n),'c'), 50000) }catch(e){ out.jsonParse='crash?' }
  try{ out.sclone = mx(n=>structuredClone(deep(n)), 50000) }catch(e){ out.sclone='crash?' }
  return JSON.stringify(out)
})()`)
console.log('result:', r)
const alive = await evalIn('1+1')
console.log('alive:', alive)
await browser.close()
