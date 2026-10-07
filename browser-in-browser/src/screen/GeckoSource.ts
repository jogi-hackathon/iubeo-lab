import { CanvasScreenSource } from './CanvasScreenSource'
import { WEBSEARCH_HOME, webSearchEnabled } from '../websearch'
import type { GeckoInstance, GeckoModule, GeckoOptions } from './geckoTypes'
import type {
  NavigableScreenSource,
  PageSnapshot,
  ScreenKeyEvent,
  ScreenModifiers,
  ScreenPointerEvent,
  SnapshotScreenSource,
} from './types'

/**
 * Gecko（Firefox のエンジン）を WebAssembly 化したものを、このタブの中で走らせる
 * 画面ソース。サーバもリモートセッションも無く、レイテンシもゼロ。
 *
 * エンジン自身の canvas をそのまま CRT のテクスチャに流し、3D 世界の入力を
 * 合成 DOM イベントとして投げ返す。こうすることでエンジンの入力パイプラインを
 * そのまま再利用でき、コマンドプロトコルを二重実装せずに済む。
 *
 * 合成モードが 2 つあり、テクスチャの読み方が変わる:
 *
 *  - **ソフトウェア合成（既定）。** エンジンは毎フレーム BGRA を 2D コンテキストへ
 *    blit し、こちらは dirty 通知でそれを読む。コンテンツの WebGL は使えない
 *    （JS から見える WebGL は out-of-process canvas IPC 経由で、RenderDocument の
 *    ソフトウェア合成にはコンポジタが居ないため）。
 *  - **GPU 合成（`?env.GECKO_GPU=1&env.GECKO_GL_PASSTHROUGH=1`）。** WebRender が
 *    #screen へ直接合成するのでコンテンツの WebGL も動く。ただしエンジン側に
 *    「フレームを渡す」ループが無いので、こちらから毎フレーム読み直す
 *    （liveSurface を参照）。
 *
 * なお GPU モードでは #screen の制御が Renderer スレッドの OffscreenCanvas へ
 * 移るが、placeholder の <canvas> は「画像ソース」としては生きているので
 * drawImage / texImage2D はそのまま合成結果を返す（getContext や toDataURL は
 * InvalidStateError になる）。
 *
 * cross-origin isolation は必須。pthread が SharedArrayBuffer を使うため、COOP:
 * same-origin + COEP: require-corp が必要（vite.config.ts が付与している）。
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

/**
 * 深い混在ティア再帰（WJ↔PBL ピンポン）でホスト課金が尽きて InternalError を投げ、
 * React の mount が死ぬサイトのブロックリスト。`_wj_set_depth_limit(1)` を投げると
 * call を含む全 JIT 関数が entry で suspend し、以降の JS→WJ entry は全部 PBL の
 * ヒープシャドウスタックへ委譲される = そのサイトだけ実行時に PBL 運転できる。
 * （GECKO_NOWASMJIT=1 と違い、エンジン再起動が要らない。）
 */
const PBL_ONLY_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
const WJ_DEPTH_PBL_ONLY = 1
const WJ_DEPTH_DEFAULT = 480000

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

/**
 * manifest が `*.wasm.zst` を指していても、同じ場所に非圧縮の `*.wasm` があれば
 * そちらを使う。非圧縮ならブラウザが application/wasm + HTTP キャッシュ付きで
 * 配信するため instantiateStreaming（ダウンロードと並行してコンパイル）が効き、
 * zstd 展開（150MB 級で 1 秒前後）も丸ごと省ける。ローカルに wasm を展開して
 * 置いた場合だけ自動で速くなる、という位置付け。
 */
async function preferUncompressed(
  wasm: NonNullable<EngineManifest['wasm']>,
): Promise<{ url: string; compressed: boolean }> {
  const url = wasm.url ?? ''
  if (!wasm.compressed || !url.endsWith('.zst')) {
    return { url, compressed: !!wasm.compressed }
  }
  const raw = url.slice(0, -'.zst'.length)
  try {
    const response = await fetch(raw, { method: 'HEAD' })
    if (response.ok && (response.headers.get('content-type') ?? '').includes('wasm')) {
      return { url: raw, compressed: false }
    }
  } catch {
    /* 圧縮版のまま */
  }
  return { url, compressed: true }
}

interface EngineManifest {
  entry?: string
  wasm?: { url?: string; compressed?: boolean }
  version?: string
  builtAt?: string
}

interface ResolvedEngine {
  entry: string
  wasm: { url: string; compressed: boolean }
  version?: string
}

/** `?engine=` に使えるディレクトリ名（versions.json の dir と対応）。 */
const ENGINE_DIR_PATTERN = /^[\w.-]+$/

/**
 * `npm run engine:link` が書き出したマニフェストを読む。無ければ既知のパスを総当たりする。
 * `?engine=v0.0.1` のようにバージョンディレクトリを指定すると、そのマニフェストを読む
 * （engine:link が public/engine/<dir>/ に並べて置く形式）。無ければ既定の
 * /engine/manifest.json（= 最後にリンクしたバージョン）へフォールバックする。
 * 見つからなければ null（= エンジン未接続）を返し、例外は投げない。
 */
async function resolveEngine(): Promise<ResolvedEngine | null> {
  const requested = new URLSearchParams(location.search).get('engine') ?? ''
  const manifestUrls = [
    ENGINE_DIR_PATTERN.test(requested) ? `/engine/${requested}/manifest.json` : '',
    '/engine/manifest.json',
  ].filter(Boolean)

  for (const url of manifestUrls) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) continue
      const manifest = (await response.json()) as EngineManifest
      if (manifest.wasm?.url) {
        return {
          entry: manifest.entry ?? ENTRY_FALLBACK,
          wasm: await preferUncompressed(manifest.wasm),
          version: manifest.version,
        }
      }
    } catch {
      /* 次の候補へ */
    }
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
 * 起動前にエンジンの重い資産を裏で温める。gecko.js はバンドル + 埋め込み
 * gecko.data で 13MB 級あり、import（fetch+パース+評価）をモジュールマップに
 * 載せておくとクリック時の待ちから消せる。
 * wasm 本体はここでは取らない: localhost 配信なら 150MB でも sub-second だし、
 * わざわざ arrayBuffer に抱え込むとメモリを圧迫するだけ。非圧縮 .wasm は
 * max-age 付きで配信されるので、一度起動すれば以降は HTTP キャッシュが効く。
 */
export function prewarmEngine(): void {
  void (async () => {
    const resolved = await resolveEngine()
    if (!resolved) return
    try {
      await import(/* @vite-ignore */ resolved.entry)
    } catch {
      /* 本起動時に改めて判定する */
    }
  })()
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
<p style="margin:8px 0 0;color:#8b8b96">JS is JIT-compiled to Wasm at runtime (disable with <code>?env.GECKO_NOWASMJIT=1</code>), but heavy sites are still slower than native. The point is being fully local: zero network latency, no server. Latin text only &mdash; the minimal GRE ships no CJK font, so Japanese would render as boxes.</p></div>
</body></html>`
}

export class GeckoSource
  extends CanvasScreenSource
  implements NavigableScreenSource, SnapshotScreenSource
{
  readonly id = 'gecko'
  readonly label = 'Gecko (wasm エンジン)'
  readonly note = 'Firefox のエンジンそのものを WebAssembly 化。完全にローカルで動作しサーバ不要'

  private engine: GeckoInstance | null = null
  private ready = false
  private url = ''
  private readonly wispUrl?: string
  private progressTimer?: number
  /** エンジンが GPU モードで走っているか（#screen に直接合成しているか）。 */
  private gpuMode = false
  /** PBL_ONLY_HOSTS 内のページを見ている間 true。wjPinTimer が depth limit を 1 にピン留めする。 */
  private pblOnly = false
  /** wjProbeStack が実測キャリブレーションで書き込んだ既定値（記憶して復帰に使う）。 */
  private wjDepthDefault = WJ_DEPTH_DEFAULT
  private origSetDepthLimit?: (v: number) => void
  private wjPinTimer?: number
  private locPollTimer?: number
  private trackedUrl = ''

  /**
   * GPU モードのエンジンはフレームをこちらへ通知せず #screen へ直接合成するので、
   * dirty を待たず毎フレーム CanvasTexture を読み直す。ソフトウェアモードでは
   * エンジンが blit のたびに dirty を立ててくれるので、そちらは従来どおり。
   */
  get liveSurface(): boolean {
    return this.gpuMode
  }

  constructor(host: HTMLElement, width: number, height: number) {
    super(host, width, height, 'screen')

    const params = new URLSearchParams(location.search)
    const wisp = params.get('wisp') ?? (import.meta.env.VITE_WISP_URL as string | undefined) ?? ''
    this.wispUrl = wisp.trim() || undefined
  }

  get currentUrl(): string {
    return this.url
  }

  /** WISP が設定されているか（実サイトに出られるか）。HUD の案内文に使う。 */
  get hasWisp(): boolean {
    return !!this.wispUrl
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

    // エンジンはソフトウェア合成の各フレームを putImageData で書き込むだけで、
    // こちらへ dirty 通知を出さない。入力イベント経由でしか dirty が立たないため、
    // 動画やアニメーションの更新がテクスチャに載らない。canvas はこちらの所有物
    // なので、getContext が返す 2D コンテキストの putImageData を包んで、
    // 書き込みのたびに dirty を立てる。エンジンの内部実装には触れない。
    this.patchBlitNotify()

    const env: Record<string, string> = {
      // GPU モードは既定では入れない。使うときは
      // `?env.GECKO_GPU=1&env.GECKO_GL_PASSTHROUGH=1`（後者がコンテンツ WebGL の有効化）。
      GECKO_COARSE_CLOCK: '1',
    }
    // `?env.FOO=bar` でエンジンの環境変数を任意に渡せる（デバッグ用）。
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (key.startsWith('env.')) env[key.slice(4)] = value
    }
    // ホスト側から丸ごと差し替える抜け道（上流のデモと同じ規約）。
    const hostEnv = (window as unknown as { GECKO_ENV?: Record<string, string> }).GECKO_ENV
    if (hostEnv) Object.assign(env, hostEnv)

    // GPU モードならテクスチャの読み方を変える（liveSurface を参照）。
    this.gpuMode = !!env.GECKO_GPU

    const sizeMb = resolved.wasm.compressed ? '32MB' : '150MB'
    const startedAt = performance.now()
    // 初回は wasm の取得・展開・インスタンス化で数十秒かかるので、経過時間を出す。
    this.progressTimer = window.setInterval(() => {
      const seconds = Math.round((performance.now() - startedAt) / 1000)
      this.setDetail(`エンジンを起動中… ${seconds} 秒（${sizeMb} の wasm を読み込んでいます）`)
    }, 1000)
    this.setStatus('booting', `エンジンを起動中… 0 秒（${sizeMb} の wasm を読み込んでいます）`)

    // WISP プロキシの疎通確認を wasm 起動と並行して走らせる。プロキシが
    // 死んでいる/応答しないと最初のページ読み込みが永久に待ち状態になり、
    // 画面が真っ黒のまま見えるため、事前に切り分ける。
    const wispCheck = this.checkWisp()

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
      this.wrapDepthLimit(engine)
      await engine.resize(this.width, this.height)

      // wasm の展開・起動フェーズはここで終わり。タイマーを止めて以降の
      // 「ページ読み込み中」の表示が上書きされないようにする。
      if (this.progressTimer !== undefined) {
        window.clearInterval(this.progressTimer)
        this.progressTimer = undefined
      }

      // Web Search モード（かつ実サイトに出られる WISP 設定あり）なら Google の
      // 検索画面を最初のページにする。オフラインやモード OFF では従来どおり
      // ネットワーク不要のウェルカムページ。WISP への疎通が取れない場合も
      // ウェルカムページにフォールバックし、警告を出す（真っ黒で固まらない）。
      let wispOk = false
      let firstPage = pageToDataUrl(welcomePage(!!this.wispUrl))
      if (this.wispUrl) {
        wispOk = await wispCheck
        if (wispOk && webSearchEnabled()) firstPage = WEBSEARCH_HOME
      }

      const versionTag = resolved.version ? ` v${resolved.version}` : ''
      const network = this.wispUrl
        ? wispOk
          ? `WISP 経由 ${this.wispUrl}`
          : `⚠ WISP プロキシ ${this.wispUrl} に接続できません（組み込みページのみ動作）`
        : 'オフライン'
      const readyDetail = `Gecko エンジン${versionTag} · ${network}`

      // data: の組み込みページは一瞬で読み込めるので待ってから ready にする。
      // http(s)（WISP 経由の実サイト）は INTERACTIVE までエンジン内部で待つため
      // 重いページだと数十秒かかる。ready を遅らせるとずっと「起動中」に見えるので、
      // 読み込みはバックグラウンドに回し、逐次描画に任せる。
      let firstPageLoad: Promise<void> | null = null
      if (firstPage.startsWith('data:')) {
        await this.load(firstPage)
      } else {
        firstPageLoad = this.load(firstPage)
      }

      this.ready = true
      this.startLocationTracking()
      this.markDirty()
      if (firstPageLoad) {
        // 最初のページの読み込みが終わるまでは進行状況をステータスに残す。
        this.setStatus('ready', `${readyDetail} · 最初のページを読み込んでいます…`)
        void firstPageLoad
          .catch((error) => {
            console.warn('[gecko] 最初のページの読み込みに失敗しました', error)
          })
          .finally(() => this.setDetail(readyDetail))
      } else {
        this.setStatus('ready', readyDetail)
      }
    } catch (error) {
      this.setStatus('error', `エンジンの起動に失敗しました: ${describe(error)}`)
    } finally {
      if (this.progressTimer !== undefined) {
        window.clearInterval(this.progressTimer)
        this.progressTimer = undefined
      }
    }
  }

  /**
   * WISP プロキシへの WebSocket 疎通確認。握手（onopen）までを見る。
   * 応答しない・拒否される場合は 8 秒で諦めて false。wisp プロトコル
   * 自体の検証はしない（接続を開くだけですぐ閉じる）。
   */
  private checkWisp(): Promise<boolean> {
    const url = this.wispUrl
    if (!url) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean, ws?: WebSocket) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (ws) {
          ws.onopen = ws.onerror = ws.onclose = null
          try {
            ws.close()
          } catch {
            /* ignore */
          }
        }
        resolve(ok)
      }
      let ws: WebSocket
      try {
        ws = new WebSocket(url.endsWith('/') ? url : `${url}/`)
      } catch {
        resolve(false)
        return
      }
      const timer = window.setTimeout(() => finish(false, ws), 8000)
      ws.onopen = () => finish(true, ws)
      ws.onerror = () => finish(false, ws)
    })
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
    this.applyDepthLimitFor(target)
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

  /**
   * ソフトウェアモードでエンジンの blit（putImageData）を dirty 通知に繋ぐ。
   * GPU モードでは 2D コンテキストを取らないので実質無効（liveSurface が担う）。
   */
  private patchBlitNotify(): void {
    const canvas = this.canvas as HTMLCanvasElement & { __bibBlitPatched?: boolean }
    if (canvas.__bibBlitPatched) return
    canvas.__bibBlitPatched = true
    const origGetContext = canvas.getContext.bind(canvas)
    const onBlit = () => this.markDirty()
    canvas.getContext = ((contextId: string, options?: unknown) => {
      const ctx = origGetContext(
        contextId as '2d',
        options as CanvasRenderingContext2DSettings | undefined,
      )
      if (
        contextId === '2d' &&
        ctx &&
        !(ctx as { __bibPutPatched?: boolean }).__bibPutPatched
      ) {
        const c2d = ctx as CanvasRenderingContext2D & { __bibPutPatched?: boolean }
        const origPut = c2d.putImageData.bind(c2d)
        c2d.putImageData = ((...args: Parameters<CanvasRenderingContext2D['putImageData']>) => {
          origPut(...args)
          onBlit()
        }) as typeof c2d.putImageData
        c2d.__bibPutPatched = true
      }
      return ctx
    }) as typeof canvas.getContext
  }

  /**
   * ブロックリストに載る origin への遷移前に WJ の深さ制限を 1 に潰して実質 PBL
   * 運転に切り替える。一度立った suspend watermark は jitDepth が 0 に戻ると解除
   * されるが、limit=1 のままなので PBL のまま動き続ける。`data:`/`about:` や
   * リスト外のサイトでは既定値へ戻す。
   *
   * glue の wjProbeStack は pthread worker 側の Module._wj_set_depth_limit を直接
   * 呼ぶため mod に掛けたラッパーを素通りし、最初の wasmhost_instantiate（= サイト
   * ロード中）にキャリブ値で上書きしてしまう。そこで pblOnly 中は interval で
   * 値をピン留めする（1 呼び出しは数 µs で、probe の単発書き込みを確実に潰せる）。
   */
  private applyDepthLimitFor(url: string): void {
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* data: 等は PBL 化しない */
    }
    this.pblOnly = PBL_ONLY_HOSTS.has(host)
    if (this.wjPinTimer !== undefined) {
      window.clearInterval(this.wjPinTimer)
      this.wjPinTimer = undefined
    }
    if (this.pblOnly) {
      this.wjPinTimer = window.setInterval(() => {
        try {
          this.origSetDepthLimit?.(WJ_DEPTH_PBL_ONLY)
        } catch {
          /* エンジン停止後は握り潰す */
        }
      }, 250)
    }
    try {
      this.origSetDepthLimit?.(this.pblOnly ? WJ_DEPTH_PBL_ONLY : this.wjDepthDefault)
    } catch (e) {
      console.warn('[gecko] _wj_set_depth_limit 失敗', e)
    }
  }

  /**
   * アプリ側 navigate() を通らない遷移（ページ内クリック・リダイレクト・history
   * 操作）でもホスト判定を追従させるため、content の location.href を軽く
   * ポーリングする。about:/data: はスキップして直前の方針を維持する
   * （遷移の過渡状態で pin がちらつくのを防ぐ）。
   */
  private startLocationTracking(): void {
    this.locPollTimer = window.setInterval(() => {
      void this.trackLocation()
    }, 1000)
  }

  private async trackLocation(): Promise<void> {
    const eng = this.engine as unknown as {
      run?: (a: { op: number; url: string }) => Promise<string>
    } | null
    if (!eng?.run || this.disposed) return
    try {
      const href = await eng.run({ op: 5, url: 'location.href' })
      if (
        typeof href === 'string' &&
        /^https?:/.test(href) &&
        href !== this.trackedUrl
      ) {
        this.trackedUrl = href
        this.applyDepthLimitFor(href)
        this.url = href
      }
    } catch {
      /* content がビジーなら次の tick で */
    }
  }

  /**
   * 今開いているページの url / title / 本文先頭を引き出す（Web Search タスクの
   * 「このページを提出」で使う）。location 追跡と同じく content global の
   * eval（op=5）経由。本文は判定材料として先頭 1600 文字に切る。
   */
  async snapshotPage(): Promise<PageSnapshot | null> {
    const eng = this.engine as unknown as {
      run?: (a: { op: number; url: string }) => Promise<string>
    } | null
    if (!eng?.run || !this.ready) return null
    try {
      const raw = await eng.run({
        op: 5,
        url: `JSON.stringify((() => { try {
          return {
            url: location.href,
            title: document.title || '',
            text: (document.body ? document.body.innerText : '').slice(0, 1600),
          }
        } catch (e) {
          return { url: location.href, title: '', text: '' }
        } })())`,
      })
      if (typeof raw !== 'string' || !raw.startsWith('{')) return null
      const parsed = JSON.parse(raw) as PageSnapshot
      return typeof parsed.url === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * `mod._wj_set_depth_limit` をラップしてキャリブ値を wjDepthDefault に記憶する。
   * （実際の probe 呼び出しは worker 側の Module 経由なのでここには来ないが、
   * main thread 経由の将来の呼び出しに備えて残す。PBL 化の本体は applyDepthLimitFor
   * のピン留め。）
   */
  private wrapDepthLimit(engine: GeckoInstance): void {
    const mod = (engine as unknown as { mod?: Record<string, unknown> }).mod
    const orig = mod?._wj_set_depth_limit
    if (!mod || typeof orig !== 'function') return
    this.origSetDepthLimit = (orig as (v: number) => void).bind(mod)
    const self = this
    mod._wj_set_depth_limit = function (v: number) {
      if (v > WJ_DEPTH_PBL_ONLY) self.wjDepthDefault = v
      self.origSetDepthLimit?.(self.pblOnly ? WJ_DEPTH_PBL_ONLY : v)
    }
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
    if (this.wjPinTimer !== undefined) {
      window.clearInterval(this.wjPinTimer)
      this.wjPinTimer = undefined
    }
    if (this.locPollTimer !== undefined) {
      window.clearInterval(this.locPollTimer)
      this.locPollTimer = undefined
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
    const requested = new URLSearchParams(location.search).get('engine') ?? ''
    if (ENGINE_DIR_PATTERN.test(requested)) {
      const response = await fetch(`/engine/${requested}/manifest.json`, { method: 'HEAD' })
      if (response.ok) return true
    }
    const response = await fetch('/engine/manifest.json', { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}
