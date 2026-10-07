// ローカルデバッグ用: public/engine/<ver>/gecko.js の geckosource 文字列に
// 計装を挿入する。
//
//   node verify/patch-werr.mjs v0.0.6
//
// 1) pthread 側 self.onunhandledrejection -> 本体はそのまま、throw の前に
//    {cmd:42, wid, stack} を postMessage して真の rejection スタックを取る。
// 2) main 側の worker.onmessage ディスパッチに case 42 を足して err() で出力。
//    worker.onerror に workerID も出す。
// 既にパッチ済みなら何もしない。
import { readFileSync, writeFileSync } from 'node:fs'

const ver = process.argv[2] ?? 'v0.0.6'
const file = `public/engine/${ver}/gecko.js`
let s = readFileSync(file, 'utf8')
if (s.includes('cmd:42')) {
  console.log('already patched')
  process.exit(0)
}

const workerFrom = 'self.onunhandledrejection = e => {\\n    throw e.reason || e;\\n  };'
const workerTo =
  'self.onunhandledrejection = e => { try { postMessage({cmd:42, wid:workerID, stack:String((e.reason && (e.reason.stack || e.reason.message)) || e).slice(0,2000)}); } catch(x){} throw e.reason || e; };'
if (!s.includes(workerFrom)) {
  console.error('worker patch site not found')
  process.exit(1)
}
s = s.replace(workerFrom, workerTo)

const errFrom =
  'err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);\\n      throw e;'
const errTo =
  'err(`${message} wid=${worker.workerID} ${e.filename}:${e.lineno}: ${e.message}`);\\n      throw e;'
if (!s.includes(errFrom)) {
  console.error('onerror patch site not found')
  process.exit(1)
}
s = s.replace(errFrom, errTo)

const defFrom = 'default:\\n        // The received message'
const defTo =
  'case 42:\\n        err(`[werr] wid=${d.wid} :: ${d.stack}`);\\n        break;\\n\\n       ' +
  defFrom
if (!s.includes(defFrom)) {
  console.error('dispatch patch site not found')
  process.exit(1)
}
s = s.replace(defFrom, defTo)

writeFileSync(file, s)
console.log(`patched ${file}`)
