// cohort-probe の Node 版（V8 同一系、ブラウザ不要で高速イテレーション）。
// ブラウザ版 verify/cohort-probe.mjs と同じ variants。
//   node verify/cohort-probe.node.mjs
import { readFileSync } from 'node:fs'

const A = `${import.meta.dirname}/assets`
const B = (n) => readFileSync(`${A}/${n}`)

const mod = (b) => new WebAssembly.Module(b)
const inst = (b, imp) => new WebAssembly.Instance(mod(b), imp)

const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 })
const c1 = inst(B('cohort-callee.wasm'))
const c2 = inst(B('cohort-callee2.wasm'))
const c3 = inst(B('cohort-callee3.wasm'))
const cMed = inst(B('cohort-callee-med.wasm'))
table.set(0, c1.exports.m)
table.set(1, c2.exports.m)
table.set(2, c3.exports.m)
table.set(3, cMed.exports.m)

const run = {
  cross: inst(B('cohort-cross.wasm'), { e: { t: table } }).exports.run,
  same: inst(B('cohort-same.wasm')).exports.run,
  sameMed: inst(B('cohort-same-med.wasm')).exports.run,
  direct: inst(B('cohort-direct.wasm')).exports.run,
  directMed: inst(B('cohort-direct-med.wasm')).exports.run,
  importx: inst(B('cohort-import.wasm'), { e: { f: c1.exports.m } }).exports.run,
}

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

for (const [, fn, b, ns] of cases) for (let i = 0; i < WARM; i++) fn(N, b, ns)
await new Promise((r) => setTimeout(r, 300))
for (const [, fn, b, ns] of cases) for (let i = 0; i < 20; i++) fn(N, b, ns)

console.log('  variant         ns/call')
for (const [name, fn, b, ns] of cases) {
  const t0 = performance.now()
  let x = 0
  for (let i = 0; i < TIMED; i++) x = fn(N, b, ns)
  const ms = performance.now() - t0
  console.log(`  ${name.padEnd(16)} ${((ms * 1e6) / (TIMED * N)).toFixed(3).padStart(8)}   result=${x}  (${ms.toFixed(0)}ms)`)
}
console.log(`node ${process.version}`)
