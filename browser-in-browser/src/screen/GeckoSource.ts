import { CanvasScreenSource } from './CanvasScreenSource'
import type { GeckoInstance, GeckoModule, GeckoOptions } from './geckoTypes'
import type {
  NavigableScreenSource,
  ScreenKeyEvent,
  ScreenModifiers,
  ScreenPointerEvent,
} from './types'

/**
 * Gecko（Firefox のエンジン）を WebAssembly 化したものを、このタブの中で走らせる
 * 画面ソース。サーバもリモートセッションも無く、レイテンシもゼロ。
 *
 * エンジン自身の canvas をそのまま CRT のテクスチャに流し、3D 世界の入力を
 * 合成 DOM イベントとして投げ返す。こうすることでエンジンの入力パイプラインを
 * そのまま再利用でき、コマンドプロトコルを二重実装せずに済む。
 *
 * 設計上の制約が 2 つある:
 *
 *  - **ソフトウェア合成のみ。** gecko.js の GPU モードは OffscreenCanvas を描画スレッドへ
 *    転送してしまうため、ページ側にはサンプリングできるものが残らない。GECKO_GPU を
 *    設定しないことで、エンジンは 2D コンテキストへ BGRA フレームを blit する。
 *  - **cross-origin isolation 必須。** pthread が SharedArrayBuffer を使うため、COOP:
 *    same-origin + COEP: require-corp が必要（vite.config.ts が付与している）。
 */

/** マニフェストが無いときに探す候補。 */
const ENTRY_FALLBACK = '/engine/gecko.js'
const WASM_FALLBACKS: ReadonlyArray<readonly [string, boolean]> = [
  ['/engine/gecko.wasm.zst', true],
  ['/engine/gecko.wasm', false],
]

/**
 * エンジンへ渡せる URL の上限。コマンド構造体の url フィールドが 8192 バイト固定
 * （`url@20[8192]`）なので、それを超えると静かに `NS_NewURI failed` になる。
 */
const MAX_URL_BYTES = 8192

/** UTF-8 の HTML を data: URL にする。
 *
 * `encodeURIComponent` は日本語 1 文字を 9 バイトに膨らませるため、上の 8192 バイトを
 * すぐに食い尽くす（この制限で最初の実装はページが読めなかった）。base64 なら 1 文字
 * 3 バイト→ 4 バイトなので、パーセントエンコードより遥かに余裕がある。
 */
export function pageToDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const url = `data:text/html;base64,${btoa(binary)}`
  if (url.length > MAX_URL_BYTES) {
    console.warn(
      `[gecko] ウェルカムページが長すぎます（${url.length} / ${MAX_URL_BYTES} バイト）。` +
        '切り詰められるため、内容を短くしてください。',
    )
  }
  return url
}

/**
 * 最小 GRE に焼かれているフォント。上流の stage-gre-min.sh が pdfjs の標準フォント
 * （LiberationSans 4 種）を /gre/fonts に置いている。つまり **CJK フォントは 1 つも無い**。
 *
 * このため、エンジンに読み込ませるページは ASCII で書く。日本語で書くと全部豆腐（□）に
 * なる。フォントを足すには `fs` プロバイダで GRE ツリー全体を供給する必要があり、
 * それをやると焼かれた gecko.data へのフォールバックが効かなくなり起動しなくなる
 * （実測済み）。日本語の UI は HUD（DOM 側）が担当している。
 */
export const ENGINE_FONTS_ARE_LATIN_ONLY = true

interface EngineManifest {
  entry?: string
  wasm?: { url?: string; compressed?: boolean }
  builtAt?: string
}

interface ResolvedEngine {
  entry: string
  wasm: { url: string; compressed: boolean }
}

/**
 * `npm run engine:link` が書き出したマニフェストを読む。無ければ既知のパスを総当たりする。
 * 見つからなければ null（= エンジン未接続）を返し、例外は投げない。
 */
async function resolveEngine(): Promise<ResolvedEngine | null> {
  try {
    const response = await fetch('/engine/manifest.json', { cache: 'no-store' })
    if (response.ok) {
      const manifest = (await response.json()) as EngineManifest
      if (manifest.wasm?.url) {
        return {
          entry: manifest.entry ?? ENTRY_FALLBACK,
          wasm: { url: manifest.wasm.url, compressed: !!manifest.wasm.compressed },
        }
      }
    }
  } catch {
    /* マニフェスト無し: 候補を試す */
  }

  for (const [url, compressed] of WASM_FALLBACKS) {
    try {
      const response = await fetch(url, { method: 'HEAD' })
      if (response.ok) return { entry: ENTRY_FALLBACK, wasm: { url, compressed } }
    } catch {
      /* 次の候補へ */
    }
  }
  return null
}

/**
 * 最初に表示するページ。data: URL なのでネットワークが一切不要
 * = 「サーバ不要のオフライン体験」がそのまま成立する。
 *
 * ASCII で書いているのは意図的。最小 GRE には CJK フォントが無いので、日本語を書くと
 * エンジン内では豆腐（□）になる。日本語の説明は HUD（DOM 側）が受け持っている。
 * 上の 8192 バイト制限があるため、意図的に小さく保っている。
 *
 * 本文に `onmousedown` / `onkeydown` で背景色を変える細工を入れてある。エンジンへの入力転送を
 * 自動検証するための目印で、人間にも「クリックが届いた」ことが色で分かって分かりやすい。
 */
function welcomePage(wispConfigured: boolean): string {
  const network = wispConfigured
    ? '<p class=ok>WISP proxy is configured. Type a URL above to open a real site.'
    : '<p class=warn>No WISP proxy: <code>data:</code> and <code>about:</code> work, real sites need <code>?wisp=wss://...</code>.'

  return `<!doctype html><html><head><meta charset=utf-8><title>Gecko in WebAssembly</title><style>
body{margin:0;padding:26px 30px;background:#101014;color:#e7e7ea;font:14px/1.75 sans-serif}
h1{margin:0 0 4px;font-size:21px}.sub{margin:0 0 18px;color:#8b8b96}
code{background:#1c1c22;padding:1px 5px;border-radius:4px;font-size:12px}
.c{background:#17171d;border:1px solid #26262e;border-radius:10px;padding:13px 15px;margin:0 0 11px}
.ok{color:#6ee7a8;margin:0}.warn{color:#f5c76b;margin:0}
input{margin-top:8px;width:60%;padding:7px 10px;border-radius:6px;border:1px solid #33333d;background:#0d0d11;color:inherit;font:inherit}
button{margin-left:6px;padding:7px 12px;border-radius:6px;border:1px solid #3a3a46;background:#23232c;color:inherit;font:inherit;cursor:pointer}
</style></head><body onmousedown="document.body.style.background='#16202a'" onkeydown="document.body.style.background='#2a1a20'">
<h1>This page is rendered by Gecko, compiled to WebAssembly</h1>
<p class=sub>Firefox's own engine is laying out and painting this page inside the 3D monitor.</p>
<div class=c>${network}</div>
<div class=c><p style=margin:0>Input forwarding: click below and type on your real keyboard (IME included).</p>
<input placeholder="click here and type"><button onclick="this.textContent=this.textContent=='pressed'?'again':'pressed'">press me</button></div>
<div class=c><p style=margin:0>Scrolling, context menus and text selection are the engine's own behaviour. A click turns this page blue, a key turns it red.</p>
<p style="margin:8px 0 0;color:#8b8b96">There is no JIT, so JS-heavy sites are slow. The point is being fully local: zero network latency, no server. Latin text only &mdash; the minimal GRE ships no CJK font, so Japanese would render as boxes.</p></div>
</body></html>`
}

export class GeckoSource extends CanvasScreenSource implements NavigableScreenSource {
  readonly id = 'gecko'
  readonly label = 'Gecko (wasm エンジン)'
  readonly note = 'Firefox のエンジンそのものを WebAssembly 化。完全にローカルで動作しサーバ不要'

  private engine: GeckoInstance | null = null
  private ready = false
  private url = ''
  private readonly wispUrl?: string
  private progressTimer?: number

  constructor(host: HTMLElement, width: number, height: number) {
    super(host, width, height, 'screen')

    const params = new URLSearchParams(location.search)
    const wisp = params.get('wisp') ?? (import.meta.env.VITE_WISP_URL as string | undefined) ?? ''
    this.wispUrl = wisp.trim() || undefined
  }

  get currentUrl(): string {
    return this.url
  }

  override async boot(): Promise<void> {
    if (this.status === 'booting' || this.status === 'ready') return
    this.setStatus('booting', 'エンジンの探索中…')

    const resolved = await resolveEngine()
    if (!resolved) {
      this.setStatus(
        'unavailable',
        '/engine/ にエンジンがありません。先に npm run engine:link を実行してください',
      )
      return
    }

    this.setStatus('booting', 'エンジンのバンドルを読み込み中…')
    let module: GeckoModule
    try {
      // public/ 配下を素の URL として読む。Vite に束ねさせないため @vite-ignore。
      module = (await import(/* @vite-ignore */ resolved.entry)) as GeckoModule
    } catch (error) {
      this.setStatus('unavailable', `エンジンの読み込みに失敗しました: ${describe(error)}`)
      return
    }

    const Gecko = module.Gecko ?? module.default
    if (!Gecko) {
      this.setStatus('unavailable', 'エンジンのバンドルに Gecko クラスがありません')
      return
    }

    const env: Record<string, string> = {
      // GECKO_GPU は意図的に設定しない（上記の制約を参照）。GPU モードにすると
      // サーフェスが描画スレッドへ渡り、ここでサンプリングできるものが無くなる。
      GECKO_COARSE_CLOCK: '1',
    }
    // `?env.FOO=bar` でエンジンの環境変数を任意に渡せる（デバッグ用）。
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (key.startsWith('env.')) env[key.slice(4)] = value
    }
    // ホスト側から丸ごと差し替える抜け道（上流のデモと同じ規約）。
    const hostEnv = (window as unknown as { GECKO_ENV?: Record<string, string> }).GECKO_ENV
    if (hostEnv) Object.assign(env, hostEnv)

    const sizeMb = resolved.wasm.compressed ? '32MB' : '233MB'
    const startedAt = performance.now()
    // 初回は wasm の取得・展開・インスタンス化で数十秒かかるので、経過時間を出す。
    this.progressTimer = window.setInterval(() => {
      const seconds = Math.round((performance.now() - startedAt) / 1000)
      this.setDetail(`エンジンを起動中… ${seconds} 秒（${sizeMb} の wasm を展開しています）`)
    }, 1000)
    this.setStatus('booting', `エンジンを起動中… 0 秒（${sizeMb} の wasm を展開しています）`)

    try {
      const options: GeckoOptions = {
        canvas: this.canvas,
        width: this.width,
        height: this.height,
        env,
        wasm: resolved.wasm,
        wispUrl: this.wispUrl,
        // エンジン自身のリスナーを生かし、合成 DOM イベントで叩く。
        // 座標変換と修飾キーの扱いをそのまま借用できる。
        forwardInput: true,
        print: (line) => {
          console.log('[gecko]', line)
          this.watchEngineLog(line)
        },
        printErr: (line) => {
          console.warn('[gecko]', line)
          this.watchEngineLog(line)
        },
      }

      const engine = new Gecko(options)
      this.engine = engine

      await engine.init()
      await engine.resize(this.width, this.height)

      this.setDetail('エンジン準備完了。最初のページを読み込んでいます…')
      await this.load(pageToDataUrl(welcomePage(!!this.wispUrl)))

      this.ready = true
      this.markDirty()
      this.setStatus(
        'ready',
        this.wispUrl ? 'Gecko エンジン · WISP プロキシ経由' : 'Gecko エンジン · オフライン',
      )    } catch (error) {
      this.setStatus('error', `エンジンの起動に失敗しました: ${describe(error)}`)
    } finally {
      if (this.progressTimer !== undefined) {
        window.clearInterval(this.progressTimer)
        this.progressTimer = undefined
      }
    }
  }

  /**
   * `load()` は失敗しても例外を投げない（失敗はエンジンのログにしか出ない）。
   * 静かに空白の画面になるのを防ぐため、ログを監視して状態に反映する。
   */
  private watchEngineLog(line: string): void {
    if (line.includes('NS_NewURI failed')) {
      this.setDetail(
        'ページを読み込めませんでした（URL が不正、または 8192 バイトを超えています）',
      )
    }
  }

  /** アドレス欄からの遷移。相対入力は https:// を補う。 */
  navigate(input: string): void {
    const target = normalizeUrl(input)
    if (!target || !this.ready || !this.engine) return
    this.url = target
    this.setDetail(`読み込み中: ${target}`)
    void this.engine
      .load(target)
      .then(() => {
        this.setDetail(this.wispUrl ? `${target} · WISP 経由` : target)
      })
      .catch((error) => {
        this.setDetail(`読み込みに失敗しました: ${describe(error)}`)
      })
  }

  /** 内部からの読み込み（起動時のウェルカムページ）。 */
  private async load(url: string): Promise<void> {
    if (!this.engine) return
    this.url = url
    await this.engine.load(url)
  }

  override halt(): void {
    if (this.disposed) return
    if (this.progressTimer !== undefined) {
      window.clearInterval(this.progressTimer)
      this.progressTimer = undefined
    }
    this.engine?.destroy()
    this.engine = null
    this.ready = false
    super.halt()
  }

  override async resize(width: number, height: number): Promise<void> {
    await super.resize(width, height)
    if (this.ready && this.engine) {
      try {
        await this.engine.resize(this.width, this.height)
      } catch (error) {
        console.warn('[gecko] resize に失敗しました', error)
      }
    }
  }

  override pointer(event: ScreenPointerEvent): void {
    if (!this.ready) return
    this.dispatchPointer(event)
    this.markDirty()
  }

  override wheel(
    dx: number,
    dy: number,
    x: number,
    y: number,
    modifiers: ScreenModifiers,
  ): void {
    if (!this.ready) return
    this.dispatchWheel(dx, dy, x, y, modifiers)
    this.markDirty()
  }

  override key(event: ScreenKeyEvent): void {
    if (!this.ready) return
    this.dispatchKey(event)
    this.markDirty()
  }

  /**
   * テキスト挿入（IME の確定、プログラム的な貼り付け）。
   * エンジンはキーイベントの charCode から文字を挿入するので、コードポイントごとに
   * keydown を 1 つ投げるのがちょうど期待される形になる。
   */
  override insertText(text: string): void {
    if (!this.ready) return
    for (const char of Array.from(text)) {
      const codePoint = char.codePointAt(0) ?? 0
      if (codePoint === 0x0a || codePoint === 0x0d) {
        this.dispatchKey({
          type: 'down',
          key: 'Enter',
          keyCode: 13,
          charCode: 13,
          modifiers: { alt: false, ctrl: false, shift: false, meta: false },
        })
        continue
      }
      this.dispatchKey({
        type: 'down',
        key: char,
        keyCode: 0,
        charCode: codePoint,
        modifiers: { alt: false, ctrl: false, shift: false, meta: false },
      })
    }
    this.markDirty()
  }

  override dispose(): void {
    if (this.progressTimer !== undefined) window.clearInterval(this.progressTimer)
    this.engine?.destroy()
    this.engine = null
    super.dispose()
  }
}

function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  // 明示的なスキーム（http:, data:, about: …）はそのまま。それ以外はホスト名とみなす。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `https://${value}`
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** HUD が「エンジンは接続済みか」を起動せずに判定するための軽い問い合わせ。 */
export async function probeEngine(): Promise<boolean> {
  try {
    const response = await fetch('/engine/manifest.json', { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}
