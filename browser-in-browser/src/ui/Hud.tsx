import { useEffect, useState } from 'react'
import type { ScreenStatus } from '../screen/types'
import type { SourceDescriptor } from '../screen/registry'

/** アドレス欄に渡す束。`navigate` を持たないソースでは null。 */
export interface HudAddress {
  url: string
  submit: (input: string) => void
}

interface HudProps {
  sources: SourceDescriptor[]
  activeId: string
  status: ScreenStatus
  detail: string
  engaged: boolean
  address: HudAddress | null
  onSelect: (id: string) => void
  onEngage: () => void
  onDisengage: () => void
  onPower: () => void
}

const STATUS_LABEL: Record<ScreenStatus, string> = {
  idle: '電源オフ',
  booting: '起動中',
  ready: '稼働中',
  error: 'エラー',
  unavailable: 'エンジン未接続',
}

export function Hud({
  sources,
  activeId,
  status,
  detail,
  engaged,
  address,
  onSelect,
  onEngage,
  onDisengage,
  onPower,
}: HudProps) {
  const [open, setOpen] = useState(true)
  const powered = status === 'ready' || status === 'booting'

  return (
    <>
      <div className={`hud ${open ? 'hud--open' : 'hud--closed'}`}>
        <div className="hud__bar">
          <span className="hud__title">browser-in-browser</span>
          <span className={`hud__status hud__status--${status}`}>
            <i />
            {STATUS_LABEL[status]}
          </span>
          <button className="hud__ghost" onClick={() => setOpen((value) => !value)}>
            {open ? 'たたむ' : 'ひらく'}
          </button>
        </div>

        {open && (
          <div className="hud__body">
            <div className="hud__section">
              <label className="hud__label">画面の供給元</label>
              <div className="hud__sources">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    className={`hud__source ${source.id === activeId ? 'is-active' : ''}`}
                    onClick={() => onSelect(source.id)}
                    title={source.note}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            </div>

            {address && <AddressBar address={address} powered={powered} />}

            <div className="hud__section">
              <div className="hud__row">
                <span className="hud__label">
                  キーボード {engaged ? '接続中' : '未接続'}
                  {engaged && <kbd className="hud__kbd">Esc</kbd>}
                </span>
                <button
                  className="hud__ghost"
                  onClick={engaged ? onDisengage : onEngage}
                  disabled={!powered}
                >
                  {engaged ? 'キーボードを離す' : 'キーボードを掴む'}
                </button>
              </div>
              <button className="hud__ghost hud__ghost--wide" onClick={onPower}>
                {powered ? '電源を切る' : '電源を入れる'}
              </button>
            </div>

            <p className="hud__detail">{detail}</p>
            {activeId === 'gecko' && status === 'unavailable' && <EngineInstructions />}

            <div className="hud__section hud__hints">
              <span>余白をドラッグ = 視点を回す</span>
              <span>ホイール = ズーム</span>
              <span>画面をクリック／スクロール = ブラウザ操作</span>
            </div>
          </div>
        )}
      </div>

      <div className="footer">
        <span>
          <b>画面</b>は 1 枚の <code>CanvasTexture</code>
        </span>
        <span>
          <b>クリック</b>は レイ → UV → canvas 画素
        </span>
        <span>
          <b>曲面</b>はジオメトリなので、クリックがずれない
        </span>
      </div>
    </>
  )
}

/**
 * 住所欄。DOM 側の入力なので、キーボードを画面に接続していても
 * KeyboardCapture がこの要素宛のイベントは素通しする（そちらの実装を参照）。
 */
function AddressBar({ address, powered }: { address: HudAddress; powered: boolean }) {
  const [draft, setDraft] = useState(address.url)
  const [editing, setEditing] = useState(false)

  // 画面側で遷移が起きたら追従する。ただし編集中は上書きしない。
  useEffect(() => {
    if (!editing) setDraft(address.url)
  }, [address.url, editing])

  return (
    <form
      className="hud__address"
      onSubmit={(event) => {
        event.preventDefault()
        setEditing(false)
        address.submit(draft)
      }}
    >
      <input
        value={editing ? draft : shortenUrl(draft)}
        spellCheck={false}
        autoComplete="off"
        placeholder="URL またはアドレス"
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" disabled={!powered}>
        移動
      </button>
    </form>
  )
}

/**
 * 表示用に URL を短くする。実ブラウザと同じで、フォーカスすると完全な値が出る。
 * エンジンの組み込みページは data: URL なので、そのまま出すと欄が埋め尽くされる。
 */
function shortenUrl(url: string, max = 46): string {
  if (url.length <= max) return url
  if (url.startsWith('data:')) return 'data:text/html（組み込みページ）'
  return `${url.slice(0, max - 1)}…`
}

function EngineInstructions() {
  return (
    <div className="hud__instructions">
      <p>
        エンジン本体（約 233MB の wasm）はリポジトリに入れていません。フォーク
        （thirdlf03/firefox-wasm）のビルド済みリリースを使うのが最短です:
      </p>
      <pre>
        {`# 1. ビルド済みリリースを取得
curl -LO https://github.com/thirdlf03/firefox-wasm/releases/download/v0.0.3/gecko.js-v0.0.3.tar.gz

# 2. このプロジェクトに接続
npm run engine:link -- --from gecko.js-v0.0.3.tar.gz`}
      </pre>
      <p className="hud__muted">
        自分でビルドする場合もコマンドは同じです（Linux + emsdk 6.0.1 で make libxul、
        約 15GB・数時間）。接続後もサーバは不要で、エンジンはソフトウェア合成で canvas に
        描き、こちらはそれをテクスチャとして読むだけです。
      </p>
    </div>
  )
}
