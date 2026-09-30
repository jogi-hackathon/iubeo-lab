import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// cross-origin isolation は wasm エンジン（gecko.js）が pthread のために
// SharedArrayBuffer を使うので必須。内蔵 canvas ブラウザには不要だが、
// 害は無いので常に付けておく。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * `/engine/` を「ソース」ではなく「配信物」として扱うためのプラグイン。
 *
 * 経緯: gecko.js と gecko.wasm は public/engine/ に置かれた素の配信物で、ビルドでも
 * そのままコピーされる。ところが dev サーバでは、ソース中の動的 import の式を Vite が
 * `__vite__injectQuery(specifier, 'import')` で包むため、ブラウザは
 * `/engine/gecko.js?import` を要求する。すると public 配信のミドルウェアではなく
 * 変換ミドルウェアが先に反応し、
 *   「This file is in /public ... should not be imported from source code」
 * で 500 を返す（@vite-ignore を付けても包まれるので防げない。ビルドでは包まれないため
 * `vite preview` では再現しない）。
 *
 * そこで内部ミドルウェアより前に割り込み、/engine/ 配下はクエリを落として
 * 素の静的ファイルとして返す。こうすると dev でも本番でも同じバイト列が配信され、
 * Vite の変換経路には一切乗らない。
 */
function serveEngineAssets(): Plugin {
  const root = resolve(process.cwd(), 'public', 'engine')

  const contentType = (file: string): string => {
    if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
    if (file.endsWith('.json')) return 'application/json; charset=utf-8'
    if (file.endsWith('.d.ts')) return 'text/plain; charset=utf-8'
    return 'application/octet-stream'
  }

  return {
    name: 'browser-in-browser:serve-engine-assets',
    configureServer(server) {
      // configureServer の中で直接 use() すると、Vite 内部のミドルウェアより先に走る。
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (!path.startsWith('/engine/')) return next()

        const file = resolve(root, path.slice('/engine/'.length))
        // `..` などで配信ディレクトリの外へ出ようとする要求は通さない。
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404
          res.end('engine asset not found')
          return
        }

        res.setHeader('Content-Type', contentType(file))
        // エンジンは差し替えながら開発するのでキャッシュさせない。
        res.setHeader('Cache-Control', 'no-store')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveEngineAssets()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: {
    // gecko.js はトップレベル await と wasm のストリーミング instantiate を使う。
    target: 'esnext',
    // エンジンのバンドルは public/ から配信されるので Rollup は触らない。
    // ソース側のチャンクが大きくなったときに警告が出ないよう上限だけ上げておく。
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: 'es' },
})
