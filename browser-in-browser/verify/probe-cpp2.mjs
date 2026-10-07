import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'vcb'
const WHICH = process.env.WHICH ?? 'jsonStr'
const DEPTH = process.env.DEPTH ?? '2000'
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
const evalIn = (js) => page.evaluate(async (src) => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return 'no engine'
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((r) => setTimeout(() => r('T/O'), 60000))])
}, js)
await page.evaluate(() => window.bib.source.navigate('about:blank'))
await page.waitForTimeout(2000)
const r = await evalIn(`(() => {
  function deep(n){ var o={}; for(var i=0;i<n;i++) o={c:o}; return o }
  try {
    var op = {jsonStr:function(n){JSON.stringify(deep(n))}, jsonParse:function(n){JSON.parse(deep(n),'c')}, sclone:function(n){structuredClone(deep(n))}}['${WHICH}']
    op(${DEPTH}); return 'ok ${WHICH} ${DEPTH}'
  } catch(e){ return 'threw: '+e.constructor.name+': '+e.message }
})()`)
console.log('result:', r)
console.log('alive:', await evalIn('1+1'))
await browser.close()
