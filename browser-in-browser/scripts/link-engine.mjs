#!/usr/bin/env node
/**
 * ビルド済み gecko.js（Gecko = Firefox のエンジンを WebAssembly 化したもの）を
 * このアプリに接続するスクリプト。
 *
 * エンジンは約 233MB の wasm で、ビルドには Linux + emsdk 6.0.1 + 約 15GB + 数時間が
 * 必要なので npm 依存にはできない。代わりにビルド済みリリースを取り込む:
 *
 *   https://github.com/thirdlf03/firefox-wasm/releases → gecko.js-v0.0.3.tar.gz
 *
 * thirdlf03 側のフォークを使う理由: 0.0.3 は JS→WASM JIT の lowering パッチ
 * (patches/0001) が入っている。素のエンジン（上流 HeyPuter の v0.0.1 等）だと
 * 「未対応 op が 1 つあると関数全体が PBL に落ちる」ため、実ブラウザ計測で
 * bail 6→0・object/class/accessor 系 1.63x・Date 1.14x の差が出る。
 *
 * gecko.js のバンドルは完全に自己完結している（bare import なし・gecko.data を内包）
 * ため、public/ に置いて URL から動的 import するだけでよい。ビルドには一切影響しない。
 *
 *   <from>/gecko.js          -> public/engine/gecko.js       （13.7MB・内包データ込み）
 *   <from>/gecko.wasm[.zst]  -> public/engine/               （34MB・zstd 圧縮）
 *   <from>/../package.json   -> manifest.json の version に記録（由来の追跡用）
 *   public/engine/manifest.json をここで書き出す
 *
 * 使い方:
 *   npm run engine:link -- --from ../firefox-wasm/gecko.js/dist
 *   npm run engine:link -- --from ../firefox-wasm      # gecko.js/dist を自動解決
 *   npm run engine:link -- --from ~/Downloads/gecko.js-v0.0.3.tar.gz   # 展開もする
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ENGINE = join(projectRoot, 'public', 'engine')

const USAGE = `使い方: npm run engine:link -- --from <gecko.js/dist | firefox-wasm リポジトリ | *.tar.gz>`

function fail(message) {
  console.error(`\n  ✗ ${message}\n`)
  console.error(`${USAGE}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  let from = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--from' || arg === '-f') {
      from = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (!from) {
      from = arg
    }
  }
  return from
}

/** .tar.gz なら一時ディレクトリへ展開し、展開先を返す。 */
function expandIfArchive(path) {
  if (!/\.(tar\.gz|tgz)$/i.test(path)) return path
  const target = join('/tmp', `gecko-link-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  const result = spawnSync('tar', ['-xzf', path, '-C', target], { stdio: 'inherit' })
  if (result.status !== 0) fail(`展開に失敗しました: ${path}`)
  return target
}

/** dist ディレクトリそのものか、リポジトリ／展開先のルートかを吸収する。 */
function resolveDist(from) {
  const trimmed = from.replace(/\/+$/, '')
  for (const candidate of [trimmed, join(trimmed, 'gecko.js', 'dist'), join(trimmed, 'dist')]) {
    // 必ず「ファイル」か確認する: 展開した tar のルートには gecko.js/ という
    // *ディレクトリ* があるので、existsSync だけだとルートを dist と誤認して
    // 「wasm がありません」で落ちる（tarball 経路が壊れていた原因）。
    const entry = join(candidate, 'gecko.js')
    if (existsSync(entry) && statSync(entry).isFile()) return resolve(candidate)
  }
  return null
}

/** RELEASE ビルドは zstd 圧縮、DEBUG ビルドは生 wasm。ローダはどちらも扱える。 */
function findWasm(dist) {
  const zst = join(dist, 'gecko.wasm.zst')
  if (existsSync(zst)) return { path: zst, name: 'gecko.wasm.zst', compressed: true }
  const raw = join(dist, 'gecko.wasm')
  if (existsSync(raw)) return { path: raw, name: 'gecko.wasm', compressed: false }
  return null
}

const from = parseArgs(process.argv.slice(2))
if (!from) fail('--from がありません: どこからビルド成果物を取るのか分かりません')

const fromPath = isAbsolute(from) ? from : resolve(process.cwd(), from)
if (!existsSync(fromPath)) fail(`パスが存在しません: ${fromPath}`)

const dist = resolveDist(expandIfArchive(fromPath))
if (!dist) {
  fail(
    `${fromPath} に gecko.js が見つかりません。\n` +
      '    フォークのビルド済みリリースを使うのが最短です:\n' +
      '    curl -LO https://github.com/thirdlf03/firefox-wasm/releases/download/v0.0.3/gecko.js-v0.0.3.tar.gz\n' +
      '    npm run engine:link -- --from gecko.js-v0.0.3.tar.gz\n' +
      '    自分でビルドする場合は Linux + emsdk 6.0.1 で make libxul を実行してください。',
  )
}

const wasm = findWasm(dist)
if (!wasm) {
  fail(
    `${dist} に gecko.wasm / gecko.wasm.zst がありません。\n` +
      '    成果物が不完全です（make libxul はエンジン wasm と gecko.js の両方を出力します）。',
  )
}

mkdirSync(PUBLIC_ENGINE, { recursive: true })

// 記録用: パッケージのバージョン（dist の隣の package.json）と wasm の完全なハッシュ。
const pkgPath = join(dist, '..', 'package.json')
let version = 'unknown'
if (existsSync(pkgPath)) {
  try {
    version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'
  } catch {
    version = 'unparseable'
  }
}
// 配信する wasm ファイルそのもの（.zst なら圧縮後のまま）の完全なハッシュ。
// 「リンクしたエンジンが期待したリリースか」を後から確認するための由来情報。
const wasmFileSha256 = createHash('sha256').update(readFileSync(wasm.path)).digest('hex')

// バンドルは自己完結しているので public/ に置くだけで動く。
// Vite に通さないため、ビルド時間にも成果物サイズにも影響しない。
copyFileSync(join(dist, 'gecko.js'), join(PUBLIC_ENGINE, 'gecko.js'))
copyFileSync(wasm.path, join(PUBLIC_ENGINE, wasm.name))

// 型定義は参照用に持っておくと、上流の API が変わったときに差分が分かる。
const types = join(dist, 'index.d.ts')
if (existsSync(types)) copyFileSync(types, join(PUBLIC_ENGINE, 'index.d.ts'))

const manifest = {
  entry: '/engine/gecko.js',
  wasm: { url: `/engine/${wasm.name}`, compressed: wasm.compressed },
  // 由来の追跡: どのバージョンの・どの成果物かを後から確認できるようにする。
  // version は dist の隣の package.json（= gecko.js パッケージ）から取る。
  version,
  wasmFileSha256,
  builtAt: statSync(wasm.path).mtime.toISOString(),
  linkedFrom: dist,
}
writeFileSync(join(PUBLIC_ENGINE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(1)

console.log(`
  ✓ wasm エンジンを接続しました  (gecko.js ${version})
      public/engine/gecko.js   ${mb(join(PUBLIC_ENGINE, 'gecko.js'))} MB（glue + gecko.data を内包）
      public/engine/${wasm.name}  ${mb(join(PUBLIC_ENGINE, wasm.name))} MB${wasm.compressed ? '（zstd 圧縮）' : ''}
      public/engine/manifest.json   (wasm file sha256 ${wasmFileSha256.slice(0, 16)}…)

  次: npm run dev して HUD の「Gecko (wasm エンジン)」に切り替えてください。
  初回は ${mb(join(PUBLIC_ENGINE, wasm.name))} MB の wasm を取得・展開・インスタンス化するため
  数十秒かかります。ページは cross-origin isolated（COOP/COEP）である必要がありますが、
  vite.config.ts が既にヘッダを付けています。
`)
