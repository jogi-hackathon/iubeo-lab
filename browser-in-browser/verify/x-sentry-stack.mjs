// sentry-filter bundle を content で eval して InternalError の JS スタックを取得
//   node verify/x-sentry-stack.mjs   (ENVS=GECKO_NOWASMJIT=1 で対照)
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.9-inloop'
const SRC = process.env.SRC ?? '/tmp/sentry-filter.js'
const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  pageerror:', e.message.slice(0, 150)))
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log('engine:', await page.evaluate(() => window.bib?.source?.status))
await page.evaluate(() => window.bib.source.navigate('about:blank'))
await page.waitForTimeout(2000)

const bundle = readFileSync(SRC, 'utf8')
// 例外の stack / 発火回数を取る。async 境界を越えてもよいよう window.onerror も仕掛ける。
const r = await page.evaluate(async (src) => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return 'no engine'
  const wrapped = `(function(){
    var errs=[]; var h=window.onerror;
    window.onerror=function(m,s,l,c,e){ errs.push(m+' @'+l+':'+c+' stack='+(e&&e.stack?String(e.stack).slice(0,1500):'none')); return false };
    try { (0,eval)(${JSON.stringify(src)}) } catch(e) {
      window.onerror=h;
      return 'THREW '+e.constructor.name+': '+e.message+'\\nSTACK:\\n'+String(e.stack).slice(0,2500)+'\\nASYNC_ERRS:'+errs.length;
    }
    setTimeout(function(){ window.__sentryErrs = errs }, 3000);
    window.onerror=h;
    return 'eval-ok errs='+errs.length+' '+errs.slice(0,2).join(' | ');
  })()`
  return Promise.race([eng.run({ op: 5, url: wrapped }), new Promise((r) => setTimeout(() => r('T/O'), 60000))])
}, bundle)
console.log('result:', r)
await page.waitForTimeout(4000)
const late = await page.evaluate(async () => {
  const eng = window.bib?.source?.engine
  return eng?.run({ op: 5, url: `(window.__sentryErrs||[]).slice(0,3).join(' ||| ')` })
})
console.log('late errs:', late)
await browser.close()
