// gecko.data の暫定再焼きスクリプト（エンジン再ビルドなしでフォントを焼き込む）。
//
// 使いどころ: firefox-wasm v0.0.2（フォント焼き込み版）が fork の CI でできるまでの
// 暫定手段。public/engine/gecko.js にインラインされた zstd パッケージへフォントを
// 追記し、loadPackage の files 配列（バンドル内ではエスケープ文字列 `\"` と `\n`）
// にエントリを足して remote_package_size を更新する。
//
//   node scripts/rebake-gecko-data.mjs
//   REBAKE_FONTS=/abs/a.otf,/abs/b.otf node scripts/rebake-gecko-data.mjs
//
// 恒久運用は fork の CI ビルド（stage-gre-min.sh がフォントを焼く）に譲る。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'public', 'engine', 'gecko.js')
const defaultFonts = [
  join(here, '..', 'public', 'engine', 'fonts', 'NotoSansJP-Regular.otf'),
  join(here, '..', 'public', 'engine', 'fonts', 'NotoSansJP-Bold.otf'),
]
const fontPaths = (process.env.REBAKE_FONTS ?? '').split(',').filter(Boolean)
const fonts = (fontPaths.length ? fontPaths : defaultFonts).map((p) => readFileSync(p))
if (fonts.length !== 2) throw new Error('フォントは Regular/Bold の 2 つを指定（REBAKE_FONTS=a,b）')

const work = process.env.TMPDIR ?? '/tmp'
const zstPath = join(work, 'gecko.data.orig.zst')
const pkgPath = join(work, 'gecko.data.pkg')
const newPkgPath = join(work, 'gecko.data.new.pkg')
const newZstPath = join(work, 'gecko.data.new.zst')

let src = readFileSync(target, 'utf8')
const re = /(data:application\/octet-stream;base64,)([A-Za-z0-9+/=]+)/
const m = src.match(re)
if (!m) throw new Error('inline gecko.data（base64 zstd）が見つからない')

// 1. 現行パッケージを展開し、末尾へフォントを追記して再圧縮
writeFileSync(zstPath, Buffer.from(m[2], 'base64'))
execFileSync('zstd', ['-d', '-f', zstPath, '-o', pkgPath])
const pkg = readFileSync(pkgPath)
let cursor = pkg.length
const entries = fonts.map((bytes) => {
  const e = { start: cursor, end: cursor + bytes.length }
  cursor = e.end
  return e
})
const total = cursor
writeFileSync(newPkgPath, Buffer.concat([pkg, ...fonts]))
execFileSync('zstd', ['-19', '-f', newPkgPath, '-o', newZstPath])
console.log(`package: ${pkg.length} → ${total} B（fonts +${total - pkg.length} B）`)

// 2. loadPackage JSON の末尾エントリ直後に 2 エントリ挿入。
//    バンドル内のメタデータは「エスケープ文字列」で、`\"` と `\n` はそれぞれ
//    バックスラッシュ+1文字の2文字列。混乱しないよう BS 連結で作る。
const BS = '\\'                       // 1 文字のバックスラッシュ
const N = pkg.length
const q = (s) => BS + '"' + s + BS + '"'   // \"s\"
const bsN = BS + 'n'                  // \n （2 文字列）
const anchor = q('end') + ': ' + N + bsN + '    } ]'
if (src.split(anchor).length - 1 !== 1) {
  throw new Error(`末尾アンカーが一意でない（出現 ${src.split(anchor).length - 1} 回）`)
}
const fontNames = (fontPaths.length ? fontPaths : defaultFonts).map((p) => p.split('/').pop())
// エントリは「開き { + フィールド」まで（閉じ } は区切り側が持つ）。手動手術で
// 実証済みの構造に合わせる:
//   ...
//     }, {
//       "filename": "/gre-baked/fonts/NotoSansJP-Regular.otf",
//       "start": N, "end": E
//     }, {
//       ...
//     } ]
const openEntry = (e, name) => '{' +
  bsN + '      ' + q('filename') + ': ' + q('/gre-baked/fonts/' + name) + ',' +
  bsN + '      ' + q('start') + ': ' + e.start + ',' +
  bsN + '      ' + q('end') + ': ' + e.end
const insertion =
  q('end') + ': ' + N + bsN + '    }, ' +
  openEntry(entries[0], fontNames[0]) +
  bsN + '    }, ' +
  openEntry(entries[1], fontNames[1]) +
  bsN + '    } ]'
src = src.replace(anchor, insertion)

// 3. remote_package_size 更新
const sizeKey = q('remote_package_size') + ': ' + N
if (!src.includes(sizeKey)) throw new Error('remote_package_size が見つからない')
src = src.replace(sizeKey, q('remote_package_size') + ': ' + total)

// 4. base64 データ URI 交換
src = src.replace(re, m[1] + readFileSync(newZstPath).toString('base64'))

writeFileSync(target, src)
console.log(
  `gecko.js 更新済み（${(src.length / 1024 / 1024).toFixed(1)} MB）: ` +
    fontNames.map((n) => `/gre-baked/fonts/${n}`).join(', '),
)