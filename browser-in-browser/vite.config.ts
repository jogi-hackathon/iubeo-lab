import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
    if (file.endsWith('.wasm')) return 'application/wasm'
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
        // エンジンは差し替えながら開発するのでキャッシュさせない。ただし
        // .wasm は V8 の streaming-compile code cache が HTTP cache に紐付く
        // ため、生 .wasm 配信の時だけ cacheable にする（code-cache 実験）。
        res.setHeader(
          'Cache-Control',
          file.endsWith('.wasm') ? 'public, max-age=3600' : 'no-store',
        )
        createReadStream(file).pipe(res)
      })
    },
  }
}

/**
 * Web Search タスクの判定エンドポイント（POST /api/judge）。
 *
 * ブラウザ側からは TypeSafe Jev の CLI を直接叩けないので、dev/preview サーバが
 * ここで spawn して肩代わりする。提出されたページ（url/title/本文先頭）とお題を
 * `jev score` の state として JSON で渡し、0..3 の段階評価をそのまま返す。
 * jev のバイナリは `JEV_BIN` で差し替え可（既定: PATH か ~/.local/bin/jev）。
 */
const JEV_BIN =
  process.env.JEV_BIN ??
  (existsSync(join(homedir(), '.local/bin', 'jev'))
    ? join(homedir(), '.local/bin', 'jev')
    : 'jev')

const JUDGE_LEVELS = [
  'unrelated: the page has nothing to do with the search query',
  'weak: only tangentially related, or not a real answer (a search results page, portal, ad, or login wall)',
  'relevant: a reasonable result that answers the query',
  'ideal: the canonical destination for this query (official site, primary source)',
]

const JUDGE_TIMEOUT_MS = 90_000

interface JudgeRequest {
  query?: unknown
  url?: unknown
  title?: unknown
  text?: unknown
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function runJev(state: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolveRun, reject) => {
    const args = [
      'score',
      '--json-state',
      '-q',
      'The user was given a web search query and asked to submit the most appropriate site for it. Judge how appropriate the submitted page is as an answer to that query.',
      '-s',
      '-',
    ]
    for (const level of JUDGE_LEVELS) args.push('-l', level)
    const child = spawn(JEV_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`jev timed out after ${JUDGE_TIMEOUT_MS / 1000}s`))
    }, JUDGE_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`jev exited ${code}: ${stderr.slice(-400)}`))
        return
      }
      try {
        resolveRun(JSON.parse(stdout) as Record<string, unknown>)
      } catch {
        reject(new Error(`jev returned non-JSON output: ${stdout.slice(-200)}`))
      }
    })
    child.stdin.end(JSON.stringify(state))
  })
}

function judgeApi(): Plugin {
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if ((req.url ?? '').split('?')[0] !== '/api/judge') return next()
    const send = (status: number, body: Record<string, unknown>) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })

    let input: JudgeRequest
    try {
      input = JSON.parse(await readBody(req)) as JudgeRequest
    } catch {
      return send(400, { ok: false, error: 'invalid JSON body' })
    }
    const query = String(input.query ?? '').slice(0, 200).trim()
    const url = String(input.url ?? '').slice(0, 500).trim()
    const title = String(input.title ?? '').slice(0, 300)
    const text = String(input.text ?? '').slice(0, 2000)
    if (!query || !/^https?:\/\//.test(url)) {
      return send(400, { ok: false, error: 'query と http(s) の url が必要です' })
    }

    try {
      const result = await runJev({ query, url, title, text })
      const answer = (result.answers as Record<string, unknown> | undefined)?.answer as
        | { score?: number; confidence?: number; probabilities?: Record<string, number> }
        | undefined
      if (typeof answer?.score !== 'number') {
        return send(502, { ok: false, error: 'jev の応答にスコアがありません' })
      }
      const max = JUDGE_LEVELS.length - 1
      const level = Math.max(0, Math.min(max, Math.round(answer.score)))
      send(200, {
        ok: true,
        score: answer.score,
        max,
        label: JUDGE_LEVELS[level].split(':')[0],
        confidence: answer.confidence ?? null,
        probabilities: answer.probabilities ?? null,
        model: result.model ?? null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isMissing =
        message.includes('ENOENT') || message.includes('spawn jev')
      send(isMissing ? 503 : 502, {
        ok: false,
        error: isMissing
          ? `jev CLI が見つかりません（JEV_BIN で指定できます）: ${message}`
          : `jev の実行に失敗しました: ${message}`,
      })
    }
  }

  return {
    name: 'browser-in-browser:judge-api',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), serveEngineAssets(), judgeApi()],
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
