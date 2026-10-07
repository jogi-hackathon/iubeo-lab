// in-loop 後の再帰形状カバレッジ: 各形状を warmup で IC/PBL 化させてから深い再帰を投げ、
// どの経路がまだ InternalError (or 実スタック死) になるかを特定する。
//   ENGINE=v0.0.9-inloop node verify/probe-shapes2.mjs
import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.9-inloop'
const DEPTH = process.env.DEPTH ?? '20000'
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
console.log('engine status:', await page.evaluate(() => window.bib?.source?.status))
const evalIn = (js) => page.evaluate(async (src) => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return 'no engine'
  return Promise.race([eng.run({ op: 5, url: src }), new Promise((r) => setTimeout(() => r('T/O'), 60000))])
}, js)
await page.evaluate(() => window.bib.source.navigate('about:blank'))
await page.waitForTimeout(2000)

// 各形状: warmup で浅い再帰を回して tier up させてから深い呼び出し。
const ONLY = process.env.ONLY?.split(',')
const shapes = {
  direct: `function f(n){return n<=0?0:f(n-1)+1} for(let i=0;i<3000;i++)f(50); return f(D)`,
  call: `function f(n){return n<=0?0:f.call(null,n-1)+1} for(let i=0;i<3000;i++)f(50); return f(D)`,
  apply: `function f(n){return n<=0?0:f.apply(null,[n-1])+1} for(let i=0;i<3000;i++)f(50); return f(D)`,
  getter: `var m=0;var o={get g(){m--;return r()}};function r(){return m<=0?0:o.g+1} for(let i=0;i<3000;i++){m=50;r()} m=D;return r()`,
  foreach: `function r(k){if(k<=0)return 0;var s=0;[0].forEach(function(){s=r(k-1)});return s+1} for(let i=0;i<3000;i++)r(50); return r(D)`,
  map: `function r(k){if(k<=0)return 0;return [0].map(function(){return r(k-1)})[0]+1} for(let i=0;i<3000;i++)r(50); return r(D)`,
  proxy: `var m=0;var p=new Proxy({},{get(){m--;return r()}});function r(){return m<=0?0:p.x+1} for(let i=0;i<3000;i++){m=50;r()} m=D;return r()`,
  closurerec: `function mk(){return function f(n){return n<=0?0:f(n-1)+1}} var f=mk(); for(let i=0;i<3000;i++)f(50); return f(D)`,
  mutual: `function a(n){return n<=0?0:b(n-1)+1} function b(n){return n<=0?0:a(n-1)+1} for(let i=0;i<3000;i++)a(50); return a(D)`,
  // エンジンごと殺す可能性が高いので最後
  bound: `function f(n){return n<=0?0:g(n-1)+1} var g=f.bind(null); for(let i=0;i<3000;i++)g(50); return g(D)`,
}
for (const [name, body] of Object.entries(shapes)) {
  const src = `(()=>{try{${body.replace(/D(?![a-zA-Z])/g, DEPTH)}}catch(e){return 'threw '+e.constructor.name+': '+String(e.message).slice(0,80)}})()`
  const t = Date.now()
  const r = await evalIn(src)
  console.log(`  ${name.padEnd(11)} depth=${DEPTH} => ${r}  (${((Date.now() - t) / 1000).toFixed(1)}s)`)
  if (r === 'T/O') { console.log('  engine wedged, abort'); break }
}
console.log('alive:', await evalIn('1+1'))
await browser.close()
