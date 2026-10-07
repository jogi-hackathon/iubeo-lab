// cohort A/B: 同じ JIT arm を env.GECKO_WJ_COHORT 有無で交互に測る。
//   BASE_URL=http://localhost:5199 node verify/bench-cohort.mjs
//   BENCHES=call-chain,call-poly ITERS=30 WARM=3 CAPS=0,16 REPS=2

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const BENCH_DIR =
  process.env.BENCH_DIR ??
  '/Users/thirdlf03/src/github.com/thirdlf03/firefox-wasm/bench/microbenches'
const BENCHES = (process.env.BENCHES ?? 'call-chain,call-poly').split(',')
const CAPS = (process.env.CAPS ?? '0,16').split(',').map(Number)
const REPS = Number(process.env.REPS ?? 2)
const ITERS = Number(process.env.ITERS ?? 30)
const WARM = Number(process.env.WARM ?? 3)
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 300_000)

const browser = await chromium.launch({ channel: 'chrome' })

async function runArm(cap) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const wj = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[wj-statsjson]') || t.includes('[wj-cohort]')) wj.push(t)
  })
  page.on('pageerror', (e) => console.log('  pageerror:', e.message))

  const env = cap > 0 ? `env.GECKO_WJ_COHORT=${cap}&env.GECKO_WJ_STATSJSON=4000` : 'env.GECKO_WJ_STATSJSON=4000'
  await page.goto(`${BASE}/?${env}`, { waitUntil: 'load' })
  await page.waitForSelector('#root canvas', { timeout: 20_000 })
  await page.waitForTimeout(2000)
  await page.click('.hud__source >> nth=1')
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let status = 'booting'
  while (Date.now() < deadline) {
    status = await page.evaluate(() => window.bib.source.status)
    if (status === 'ready' || status === 'error' || status === 'unavailable') break
    await page.waitForTimeout(2000)
  }
  if (status !== 'ready') {
    await page.close()
    return { status, benches: {}, wj }
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
    const out = await page.evaluate((c) => window.bib.source.engine.evalChrome(c), program)
    try {
      benches[name] = JSON.parse(out)
    } catch {
      benches[name] = { raw: String(out).slice(0, 120) }
    }
  }
  await page.close()
  return { status, benches, wj }
}

const sums = {}
for (let rep = 0; rep < REPS; rep++) {
  for (const cap of CAPS) {
    const r = await runArm(cap)
    for (const b of BENCHES) {
      const v = r.benches[b]
      sums[b] ??= {}
      if (v?.perIter != null) {
        sums[b][cap] ??= []
        sums[b][cap].push(v.perIter)
        if (rep === 0 && cap === CAPS[0]) sums[b].sum = v.sum
        else if (String(v.sum) !== String(sums[b].sum)) console.log(`  !! ${b} sum mismatch ${v.sum} vs ${sums[b].sum}`)
      } else console.log(`  !! ${b} cap=${cap} raw=${JSON.stringify(v)}`)
    }
    const last = r.wj.filter((l) => l.includes('statsjson')).pop()
    if (last) {
      const m = last.match(/"cohorts":(\d+),"cohortMembers":(\d+),"cohortEdgePulls":(\d+)/)
      if (m) console.log(`  [rep${rep} cap=${cap}] cohorts=${m[1]} members=${m[2]} edgePulls=${m[3]}`)
    }
    console.log(`  [rep${rep} cap=${cap}] ` + BENCHES.map((b) => `${b}=${r.benches[b]?.perIter?.toFixed(2) ?? 'ERR'}ms`).join(' '))
  }
}
console.log('\n  bench            ' + CAPS.map((c) => `cap${c}(ms)`.padStart(12)).join(' ') + '   delta')
for (const b of BENCHES) {
  const row = CAPS.map((c) => {
    const a = sums[b][c] ?? []
    return (a.length ? Math.min(...a).toFixed(2) : '-').padStart(12)
  }).join(' ')
  const s = sums[b][CAPS[0]]?.length && sums[b][CAPS.at(-1)]?.length
    ? `${(((Math.min(...sums[b][CAPS.at(-1)]) / Math.min(...sums[b][CAPS[0]])) - 1) * 100).toFixed(1)}%`
    : ''
  console.log(`  ${b.padEnd(16)} ${row}   ${s}`)
}
await browser.close()
