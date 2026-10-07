import { useCallback, useEffect, useRef, useState } from 'react'
import {
  initialTask,
  judgeSite,
  pickTask,
  setWebSearchEnabled,
  TASK_PRESETS,
  WEBSEARCH_HOME,
  webSearchEnabled,
  type JudgeResult,
} from '../websearch'
import {
  canSnapshot,
  isNavigable,
  type ScreenSource,
} from '../screen/types'

interface WebSearchPanelProps {
  /** 電源が入っていて画面が操作できるか。 */
  powered: boolean
  /** 現在の画面ソース（Gecko など）。 */
  source: ScreenSource | null
}

interface Attempt {
  task: string
  url: string
  title: string
  result: JudgeResult
}

/**
 * 「Web Search」タスクのパネル。
 *
 * お題の検索ワードが出るので、ユーザーは 3D 画面の中のブラウザ（Google が
 * 最初に開いている）で実際に検索し、「これが答え」と思うページを開いて
 * 「このページを提出」を押す。提出されたページの url / title / 本文先頭を
 * dev サーバの /api/judge（TypeSafe Jev）へ送り、適切さを 0..3 で採点する。
 *
 * モードの ON/OFF は localStorage 永続化。ON のとき Gecko は起動直後に
 * Google を開く（GeckoSource の起動ページを参照）。
 */
export function WebSearchPanel({ powered, source }: WebSearchPanelProps) {
  const [enabled, setEnabled] = useState(webSearchEnabled)
  const [task, setTask] = useState(() => initialTask())
  const [custom, setCustom] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<Attempt | null>(null)
  const [history, setHistory] = useState<Attempt[]>([])
  const busyRef = useRef(false)

  const navigable = source && isNavigable(source) ? source : null
  const snapshotable = source && canSnapshot(source) ? source : null
  const hasWisp =
    source && 'hasWisp' in source ? Boolean(source.hasWisp) : true

  // 画面内の遷移（クリック等）を追うため、表示用の URL を軽くポーリングする。
  useEffect(() => {
    if (!enabled || !navigable) return
    const timer = window.setInterval(() => {
      setCurrentUrl(navigable.currentUrl)
    }, 1500)
    setCurrentUrl(navigable.currentUrl)
    return () => window.clearInterval(timer)
  }, [enabled, navigable])

  const toggle = useCallback(
    (next: boolean) => {
      setEnabled(next)
      setWebSearchEnabled(next)
      // ON にした時点でブラウザが動いているなら、すぐ検索画面へ連れて行く。
      if (next && powered && navigable) navigable.navigate(WEBSEARCH_HOME)
    },
    [navigable, powered],
  )

  const submit = useCallback(async () => {
    if (!snapshotable || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const page = await snapshotable.snapshotPage()
      if (!page || !/^https?:/.test(page.url)) {
        setVerdict({
          task,
          url: page?.url ?? '',
          title: page?.title ?? '',
          result: {
            ok: false,
            error: '提出できるページが開かれていません（http(s) のページを開いてください）',
          },
        })
        return
      }
      const result = await judgeSite(task, page)
      const attempt: Attempt = { task, url: page.url, title: page.title, result }
      setVerdict(attempt)
      setHistory((list) => [attempt, ...list].slice(0, 8))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [snapshotable, task])

  const newTask = useCallback(() => {
    setTask((current) => pickTask(current))
    setVerdict(null)
    setCustom('')
  }, [])

  const applyCustom = useCallback(() => {
    const word = custom.trim()
    if (!word) return
    setTask(word)
    setVerdict(null)
    if (powered && navigable) {
      navigable.navigate(`${WEBSEARCH_HOME}search?q=${encodeURIComponent(word)}`)
    }
  }, [custom, navigable, powered])

  const openSearch = useCallback(() => {
    navigable?.navigate(`${WEBSEARCH_HOME}search?q=${encodeURIComponent(task)}`)
  }, [navigable, task])

  const submittable =
    enabled && powered && !!snapshotable && /^https?:/.test(currentUrl)

  return (
    <div className="hud__section task">
      <div className="hud__row">
        <span className="hud__label">Web Search タスク</span>
        <label className="task__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => toggle(event.target.checked)}
          />
          <span>{enabled ? 'ON' : 'OFF'}</span>
        </label>
      </div>

      {enabled && (
        <>
          <div className="task__card">
            <span className="task__hint">お題の検索ワード</span>
            <strong className="task__word">{task}</strong>
            <div className="task__actions">
              <button className="hud__ghost" onClick={newTask}>
                別のお題
              </button>
              <button
                className="hud__ghost"
                onClick={openSearch}
                disabled={!powered || !navigable}
                title="Google でこのお題を開く"
              >
                検索する
              </button>
            </div>
            <form
              className="task__custom"
              onSubmit={(event) => {
                event.preventDefault()
                applyCustom()
              }}
            >
              <input
                value={custom}
                placeholder="自分でお題を決める"
                spellCheck={false}
                autoComplete="off"
                list="task-presets"
                onChange={(event) => setCustom(event.target.value)}
              />
              <datalist id="task-presets">
                {TASK_PRESETS.map((word) => (
                  <option key={word} value={word} />
                ))}
              </datalist>
              <button type="submit" className="hud__ghost" disabled={!custom.trim()}>
                設定
              </button>
            </form>
          </div>

          <div className="task__card">
            <span className="task__hint">現在のページ</span>
            <span className="task__url" title={currentUrl}>
              {currentUrl
                ? currentUrl.length > 52
                  ? `${currentUrl.slice(0, 51)}…`
                  : currentUrl
                : '（まだ何も開かれていません）'}
            </span>
            <button
              className="hud__ghost hud__ghost--wide task__submit"
              onClick={() => void submit()}
              disabled={!submittable || busy}
            >
              {busy ? 'Jev が判定中…' : 'このページを答えとして提出'}
            </button>
            {!hasWisp && (
              <p className="hud__muted">
                WISP が設定されていないため実サイトは開けません
                （?wisp=ws://… を付けてください）
              </p>
            )}
          </div>

          {verdict && (
            <div
              className={`task__card task__verdict ${
                verdict.result.ok
                  ? (verdict.result.score ?? 0) >= (verdict.result.max ?? 3) / 2
                    ? 'task__verdict--pass'
                    : 'task__verdict--fail'
                  : 'task__verdict--error'
              }`}
            >
              {verdict.result.ok ? (
                <>
                  <strong>
                    {verdict.result.label}（{verdict.result.score?.toFixed(2)} /{' '}
                    {verdict.result.max}）
                  </strong>
                  <span className="task__hint">
                    {verdict.url} · 確度{' '}
                    {Math.round((verdict.result.confidence ?? 0) * 100)}%
                    {verdict.result.model ? ` · ${verdict.result.model}` : ''}
                  </span>
                </>
              ) : (
                <span className="task__hint">{verdict.result.error}</span>
              )}
            </div>
          )}

          {history.length > 0 && (
            <div className="task__history">
              {history.map((attempt, index) => (
                <div key={index} className="task__history-row" title={attempt.url}>
                  <span
                    className={`task__dot ${
                      attempt.result.ok &&
                      (attempt.result.score ?? 0) >= (attempt.result.max ?? 3) / 2
                        ? 'task__dot--pass'
                        : 'task__dot--fail'
                    }`}
                  />
                  <span className="task__history-task">{attempt.task}</span>
                  <span className="task__history-score">
                    {attempt.result.ok
                      ? `${attempt.result.score?.toFixed(1)}/${attempt.result.max}`
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
