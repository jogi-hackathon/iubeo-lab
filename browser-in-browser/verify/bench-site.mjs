// 実ブラウザ内 gecko.js でサイト相当 workload の JIT(WJ) vs PBL を実測。
// firefox-wasm/bench/site の build 済み data+entry を evalChrome に連結して実行。
//
//   BASE_URL=http://localhost:5199 node verify/bench-site.mjs
//
// JIT アームには GECKO_WJ_STATSJSON を載せ、[wj-statsjson] stderr 行を拾って
// 「実コードの何割が JIT で走り何割が deopt→PBL に戻るか」も採取する。

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SITE_DIR =
  process.env.SITE_DIR ??
  '/Users/thirdlf03/src/github.com/thirdlf03/firefox-wasm/bench/site/build'
const WORKS = (process.env.WORKS ?? 'wiki:search,wiki:dom,wiki:lodash,vibey:frame3d,vibey:vibeyboot,home:dom')
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
  const wjStats = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[wj-statsjson]') || t.includes('[wj-percompile]')) wjStats.push(t)
  })
  page.on('pageerror', (e) => {
    console.log('  pageerror:', e.message)
    if (e.stack) console.log('  stack:', String(e.stack).split('\n').slice(0, 15).join('\n'))
  })

  const envBits = nowasmjit
    ? `env.GECKO_NOWASMJIT=1${process.env.PBL_EXTRA_ENV ? '&' + process.env.PBL_EXTRA_ENV : ''}`
    : `env.GECKO_WJ_STATSJSON=2000&env.GECKO_WJ_COMPILESTAT=1${process.env.JIT_EXTRA_ENV ? '&' + process.env.JIT_EXTRA_ENV : ''}`
  await page.goto(`${BASE}/?${envBits}`, { waitUntil: 'load' })
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
  console.log(`  [${nowasmjit ? 'PBL' : 'JIT'}] status=${status} boot=${bootSec}s`)
  if (status !== 'ready') {
    await page.close()
    return { bootSec, works: {}, wjStats }
  }

  const works = {}
  let dataCache = {}
  for (const w of WORKS) {
    const [site, bench] = w.split(':')
    if (!dataCache[site]) dataCache[site] = readFileSync(`${SITE_DIR}/data-${site}.js`, 'utf8')
    const benchSrc = readFileSync(`${SITE_DIR}/${bench}.js`, 'utf8')
    const program = `${dataCache[site]}\n${benchSrc}\n;(function(){
      var b=new Benchmark(); if(b.setup)b.setup();
      for(var i=0;i<${WARM};i++)b.runIteration();
      var t0=Date.now();
      for(var i=0;i<${ITERS};i++)b.runIteration();
      var ms=Date.now()-t0;
      return JSON.stringify({ms:ms,perIter:ms/${ITERS},sum:(b.result?b.result():0)});})()`
    try {
      const out = await evalBig(page, program)
      works[w] = JSON.parse(out)
      console.log(`    ${w}: ${works[w].perIter?.toFixed(2)}ms/iter`)
    } catch (e) {
      works[w] = { err: String(e).slice(0, 160) }
      console.log(`    ${w}: eval error ${e.message?.slice(0, 120)}`)
    }
  }
  await page.close()
  return { bootSec, works, wjStats }
}

// evalChrome は url@8192B のコマンド構造体経由なので、大きいプログラムは
// globalThis.__bibBuf へ分割連結してから eval する。
async function evalBig(page, src) {
  await page.evaluate(() => window.bib.source.engine.evalChrome('globalThis.__bibBuf=""'))
  const CH = 6000
  for (let i = 0; i < src.length; ) {
    let end = Math.min(i + CH, src.length)
    // JSON.stringify したリテラルが url フィールドに載る。UTF-8 化で非 ASCII は
    // 3-4B に膨らむので、バイト見積もりで切る（文字境界のみ分割）。
    while (end > i + 1 && Buffer.byteLength(JSON.stringify(src.slice(i, end)), 'utf8') > 7500)
      end--
    // サロゲートペアの途中で切らない（上位サロゲートで終わるなら1文字戻す）
    const lastCode = src.charCodeAt(end - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
    const lit = JSON.stringify(src.slice(i, end))
    await page.evaluate(
      (c) => window.bib.source.engine.evalChrome(`globalThis.__bibBuf+=${c}`),
      lit,
    )
    i = end
  }
  return page.evaluate(() =>
    window.bib.source.engine.evalChrome('eval(globalThis.__bibBuf)'),
  )
}

const jit = await runArm(false)
const pbl = await runArm(true)

console.log('\n  workload        jit(ms/iter)   pbl(ms/iter)   ratio   sumMatch')
for (const w of WORKS) {
  const j = jit.works[w]
  const p = pbl.works[w]
  if (j?.perIter != null && p?.perIter != null) {
    const match = String(j.sum) === String(p.sum) ? 'ok' : `MISMATCH ${j.sum} vs ${p.sum}`
    console.log(
      `  ${w.padEnd(15)} ${j.perIter.toFixed(2).padStart(10)}   ${p.perIter
        .toFixed(2)
        .padStart(10)}   ${(p.perIter / j.perIter).toFixed(2).padStart(6)}x  ${match}`,
    )
  } else {
    console.log(`  ${w.padEnd(15)} jit=${JSON.stringify(j)} pbl=${JSON.stringify(p)}`)
  }
}
console.log(`\n  boot: jit=${jit.bootSec}s pbl=${pbl.bootSec}s`)
if (jit.wjStats.length) {
  console.log('\n  wj-stats (JIT arm, last lines):')
  for (const l of jit.wjStats.slice(-4)) console.log('   ', l.slice(0, 300))
}

await browser.close()
