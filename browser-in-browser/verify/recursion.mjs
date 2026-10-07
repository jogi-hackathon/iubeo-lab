// JIT(WJ) で再帰 JS がホスト wasm スタックを食い潰してエンジンを殺すかの検証。
//
//   node verify/recursion.mjs            # JIT arm
//   NOJIT=1 node verify/recursion.mjs    # PBL arm（GECKO_NOWASMJIT=1）
//
// f(n){return n?f(n-1):0} を浅い深さで温めて JIT 化させた後、深い呼び出しを投げる。
// JIT なら wasm の自己再帰 → RangeError → pthread 死亡（eval が TIMEOUT 化）。
// PBL なら SpiderMonkey の JS 再帰チェックが InternalError を投げて生存するはず。
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const NOJIT = !!process.env.NOJIT

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (/\[gecko\]|\[werr\]|error|Pthread/i.test(t)) console.log(`  ${t.slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

const params = new URLSearchParams()
if (NOJIT) params.set('env.GECKO_NOWASMJIT', '1')
// GECKO_WJ_DEPTHLIMIT=<bytes> でガード閾値を下げてテストできる
//   DEPTHLIMIT=200000 node verify/recursion.mjs
if (process.env.DEPTHLIMIT) params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHLIMIT)
if (process.env.NOSTACKGUARD) params.set('env.GECKO_WJ_NOSTACKGUARD', '1')
for (const [k, v] of new URLSearchParams(process.env.ENVS ?? '')) params.set(`env.${k}`, v)
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log(`  status=${await page.evaluate(() => window.bib?.source?.status)} arm=${NOJIT ? 'PBL' : 'JIT'}`)

const evalIn = (js) =>
  page.evaluate(async (src) => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    return Promise.race([
      eng.run({ op: 5, url: src }),
      new Promise((res) => setTimeout(() => res('TIMEOUT'), 15000)),
    ])
  }, js)

// warmup: 浅い再帰を繰り返して f を JIT-worthy にする
const warm = await evalIn(
  `(function(){ function f(n){ return n ? f(n-1) : 0 } let s=0; for(let i=0;i<2000;i++) s+=f(80); return 'warm ok s='+s })()`,
)
console.log(`  warmup: ${warm}`)

// 深さをエスカレート: ガード発動深度 or クラッシュ深度を特定する
const DEPTHS = (process.env.DEPTHS ?? '1200,1500,1800,2200,2600,3000,4000,8000,500000')
  .split(',').map(Number)
for (const d of DEPTHS) {
  const r = await evalIn(
    `(function(){ function f(n){ return n ? f(n-1) : 0 } try { return 'returned '+f(${d}) } catch(e){ return 'caught '+e.name } })()`,
  )
  console.log(`  f(${d}): ${r}`)
  if (r === 'TIMEOUT') break
}

const alive = await evalIn(`'alive '+document.title.slice(0,30)`)
console.log(`  after: ${alive}`)
await browser.close()
