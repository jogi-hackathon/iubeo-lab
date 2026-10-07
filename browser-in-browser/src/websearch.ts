/**
 * 「Web Search」タスクモード。
 *
 * ベンチマークの Web Search タスクの再現: 検索ワード（お題）が出され、
 * ユーザーは画面の中のブラウザで実際に検索し、「これが答え」と思うページを
 * 提出する。提出されたページがお題に対して適切かは、dev サーバ側の
 * `/api/judge`（TypeSafe Jev の CLI を叩くミドルウェア）が採点する。
 *
 * モードの ON/OFF は localStorage に残し、GeckoSource が起動時に読んで
 * 最初のページを Google にする（OFF なら従来のウェルカムページ）。
 * `?websearch=0` はその場限りの強制 OFF。
 */
import type { PageSnapshot } from './screen/types'

export type { PageSnapshot }

/** モード ON で起動したときの最初のページ。 */
export const WEBSEARCH_HOME = 'https://www.google.com/'

const STORAGE_KEY = 'bib.websearch'

export function webSearchEnabled(): boolean {
  const params = new URLSearchParams(location.search)
  if (params.get('websearch') === '0') return false
  if (params.get('websearch') === '1') return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function setWebSearchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* プライベートモード等では書けない。その場合は URL パラメータで制御する */
  }
}

/**
 * お題のプリセット。「明確に最適なサイトが存在する」ものを中心に置いている
 * （判定が一意になりやすいので）。URL パラメータ `?task=<word>` で任意の
 * お題を指定することもできる。
 */
export const TASK_PRESETS: readonly string[] = [
  'firefox-wasm',
  'WISP protocol',
  'three.js',
  'WebAssembly',
  'emscripten',
  'Playwright',
  'Gecko engine',
  'React Three Fiber',
  'MDN Web Docs',
  'Vite',
  'wisp-js',
  'Mercury Workshop',
]

/** 最初のお題。`?task=<word>` で固定できる。なければプリセットからランダム。 */
export function initialTask(): string {
  return new URLSearchParams(location.search).get('task')?.trim() || pickTask()
}

export function pickTask(current?: string): string {
  const pool = TASK_PRESETS.filter((word) => word !== current)
  return pool[Math.floor(Math.random() * pool.length)] ?? TASK_PRESETS[0]
}

/** /api/judge の応答（jev score の結果をサーバ側で正規化した形）。 */
export interface JudgeResult {
  ok: boolean
  /** スコア（0..max）。 */
  score?: number
  max?: number
  /** スコア帯の短いラベル（サーバ側の LEVELS に対応）。 */
  label?: string
  confidence?: number
  model?: string
  error?: string
}

export async function judgeSite(
  query: string,
  page: PageSnapshot,
): Promise<JudgeResult> {
  try {
    const response = await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...page }),
    })
    const result = (await response.json()) as JudgeResult
    if (!response.ok && !result.error) {
      result.error = `判定サーバが HTTP ${response.status} を返しました`
    }
    return result
  } catch (error) {
    return {
      ok: false,
      error: `判定サーバへ届きませんでした（vite dev/preview 経由で開いてください）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
