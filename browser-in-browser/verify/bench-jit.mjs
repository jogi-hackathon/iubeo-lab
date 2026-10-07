// 実ブラウザ内 gecko.js エンジンの JIT(WJ lowering) vs PBL 実測。
//
//   node verify/bench-jit.mjs            # JIT on / PBL 両方を順に測る
//   BASE_URL=http://localhost:5199 で dev サーバを指定（既定: vite dev :5173）
//
// エンジンの evalChrome で microbench を直接実行し、GECKO_NOWASMJIT=1
// （env クエリ経由）で PBL フォールバックを測る。MICROSUM の一致で正しさも検証。

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const BENCH_DIR =
  process.env.BENCH_DIR ??
  '/Users/thirdlf03/src/github.com/thirdlf03/firefox-wasm/bench/microbenches'
const BENCHES = (process.env.BENCHES ??
  'int-arith,float-arith,prop-mono,prop-poly,string-ops,call-poly,try-catch,mathfn,date-ops')
  .split(',')
const ITERS = Number(process.env.JS_ITERS ?? 8)
const WARM = Number(process.env.JS_WARM ?? 3)
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 300_000)

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--js-flags=--max-old-space-size=4096'],
})

async function runArm(nowasmjit) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('  pageerror:', e.message))

  const url = nowasmjit ? `${BASE}/?env.GECKO_NOWASMJIT=1` : `${BASE}/`
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('#root canvas', { timeout: 20_000 })
  await page.waitForTimeout(2000)

  const bootStarted = Date.now()
  await page.click('.hud__source >> nth=1')
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let status = 'booting'
  while (Date.now() < deadline) {
    status = await page.evaluate(() => window.bib.source.status)
    if (status === 'ready' || status === 'error' || status === 'unavailable') break
    await page.waitForTimeout(2000)
  }
  const bootSec = ((Date.now() - bootStarted) / 1000).toFixed(1)
  console.log(`  [${nowasmjit ? 'PBL' : 'JIT'}] engine status=${status} boot=${bootSec}s`)
  if (status !== 'ready') {
    await page.close()
    return { bootSec, benches: {} }
  }

  const benches = {}
  for (const name of BENCHES) {
    const src = readFileSync(`${BENCH_DIR}/${name}.js`, 'utf8')
    const program = `(function(){${src}
      var b=new Benchmark(); if(b.setup)b.setup();
      for(var i=0;i<${WARM};i++)b.runIteration();
      var t0=Date.now();
      for(var i=0;i<${ITERS};i++)b.runIteration();
      var ms=Date.now()-t0;
      return JSON.stringify({ms:ms,perIter:ms/${ITERS},sum:(b.result?b.result():0)});})()`
    const out = await page.evaluate(
      (code) => window.bib.source.engine.evalChrome(code),
      program,
    )
    try {
      benches[name] = JSON.parse(out)
    } catch {
      benches[name] = { raw: String(out).slice(0, 120) }
    }
  }
  await page.close()
  return { bootSec, benches }
}

const jit = await runArm(false)
const pbl = await runArm(true)

console.log('\n  bench            jit(ms/iter)   pbl(ms/iter)   ratio   sumMatch')
for (const name of BENCHES) {
  const j = jit.benches[name]
  const p = pbl.benches[name]
  if (j?.perIter != null && p?.perIter != null) {
    const match = String(j.sum) === String(p.sum) ? 'ok' : `MISMATCH ${j.sum} vs ${p.sum}`
    console.log(
      `  ${name.padEnd(16)} ${j.perIter.toFixed(3).padStart(10)}   ${p.perIter
        .toFixed(3)
        .padStart(10)}   ${(p.perIter / j.perIter).toFixed(2).padStart(6)}x  ${match}`,
    )
  } else {
    console.log(`  ${name.padEnd(16)} jit=${JSON.stringify(j)} pbl=${JSON.stringify(p)}`)
  }
}
console.log(`\n  boot: jit=${jit.bootSec}s pbl=${pbl.bootSec}s`)

await browser.close()
