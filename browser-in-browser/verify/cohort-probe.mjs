// Hotpack 前提検証: V8 で cross-instance vs same-instance call_indirect の
// 速度差を測る。gecko 無関係の単体実験。
//
//   BASE_URL=http://localhost:5199 node verify/cohort-probe.mjs
//
// A: cross-instance call_indirect (現行 WJ topology: 1 fn = 1 module)
// B: same-instance call_indirect (cohort module, dynamic edge)
// C: same-module direct call (cohort の静的 edge 上限)
// D: cross-instance direct call via import
// + callee size (small / medium) と mono/poly(3 slot) バリエーション

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const A = `${import.meta.dirname}/assets`
const read = (n) => readFileSync(`${A}/${n}`).toString('base64')

const bytes = {
  callee: read('cohort-callee.wasm'),
  callee2: read('cohort-callee2.wasm'),
  callee3: read('cohort-callee3.wasm'),
  calleeMed: read('cohort-callee-med.wasm'),
  cross: read('cohort-cross.wasm'),
  same: read('cohort-same.wasm'),
  sameMed: read('cohort-same-med.wasm'),
  direct: read('cohort-direct.wasm'),
  directMed: read('cohort-direct-med.wasm'),
  importd: read('cohort-import.wasm'),
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.goto(`${BASE}/`, { waitUntil: 'load' })

const results = await page.evaluate(async (bytes) => {
  const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const mod = (b64) => new WebAssembly.Module(dec(b64))
  const inst = (m, imp) => new WebAssembly.Instance(mod(m), imp)

  // shared host table (like wasmhost_jit_table)
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 })
  const c1 = inst(bytes.callee)
  const c2 = inst(bytes.callee2)
  const c3 = inst(bytes.callee3)
  const cMed = inst(bytes.calleeMed)
  table.set(0, c1.exports.m)
  table.set(1, c2.exports.m)
  table.set(2, c3.exports.m)
  table.set(3, cMed.exports.m)

  const run = {
    cross: inst(bytes.cross, { e: { t: table } }).exports.run,
    same: inst(bytes.same).exports.run,
    sameMed: inst(bytes.sameMed).exports.run,
    direct: inst(bytes.direct).exports.run,
    directMed: inst(bytes.directMed).exports.run,
    importx: inst(bytes.importd, { e: { f: c1.exports.m } }).exports.run,
  }

  // (name, fn, base, nslots): 実際に呼ばれる slot = base + i%nslots
  const cases = [
    ['cross-mono', run.cross, 0, 1],
    ['cross-poly3', run.cross, 0, 3],
    ['cross-med', run.cross, 3, 1],
    ['same-mono', run.same, 0, 1],
    ['same-poly3', run.same, 0, 3],
    ['same-med', run.sameMed, 0, 1],
    ['direct', run.direct, 0, 1],
    ['direct-med', run.directMed, 0, 1],
    ['import-x', run.importx, 0, 1],
  ]

  const N = 200_000
  const WARM = 60
  const TIMED = 120

  // V8 wasm tier-up is async + no OSR -> warm with repeated calls, then sleep
  for (const [, fn, b, ns] of cases) for (let i = 0; i < WARM; i++) fn(N, b, ns)
  await new Promise((r) => setTimeout(r, 300))
  for (const [, fn, b, ns] of cases) for (let i = 0; i < 20; i++) fn(N, b, ns)

  const out = {}
  for (const [name, fn, b, ns] of cases) {
    const t0 = performance.now()
    let x = 0
    for (let i = 0; i < TIMED; i++) x = fn(N, b, ns)
    const ms = performance.now() - t0
    out[name] = { nsPerCall: (ms * 1e6) / (TIMED * N), result: x, ms }
  }
  return out
}, bytes)

console.log('\n  variant         ns/call   (steady state, post tier-up)')
for (const [k, v] of Object.entries(results))
  console.log(`  ${k.padEnd(16)} ${v.nsPerCall.toFixed(3).padStart(8)}   result=${v.result}  (${v.ms.toFixed(0)}ms)`)

await browser.close()
