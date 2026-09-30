import { CanvasScreenSource } from './CanvasScreenSource'
import { DemoBrowser } from './demo/DemoBrowser'
import type {
  CursorKind,
  NavigableScreenSource,
  ScreenKeyEvent,
  ScreenModifiers,
  ScreenPointerEvent,
} from './types'

/**
 * 既定の画面ソース：2D canvas に描かれた小さなブラウザ。
 *
 * これがあるおかげで、wasm エンジン（233MB）を接続する前から、曲面ジオメトリ・
 * レイキャスト→UV の入力変換・CRT シェーダ・キーボード捕捉・IME といった
 * マシン全体が本物として検証できる。GeckoSource に差し替えても他は何も変わらない。
 */
export class DemoBrowserSource extends CanvasScreenSource implements NavigableScreenSource {
  readonly id = 'demo'
  readonly label = '内蔵 canvas ブラウザ'
  readonly note = 'デモ用の小さなブラウザ。「canvas → テクスチャ → レイ入力」の全経路を検証する'

  private readonly browser: DemoBrowser

  constructor(host: HTMLElement, width: number, height: number) {
    super(host, width, height, 'demo-screen')
    this.browser = new DemoBrowser(this.canvas)
  }

  async boot(): Promise<void> {
    if (this.status === 'ready') return
    this.setStatus('booting', '最初のページを描画しています…')
    // エンジンと違い一瞬で立ち上がるので、1 フレーム描けば十分。
    this.browser.render()
    this.markDirty()
    this.setStatus('ready', this.detailLine())
  }

  /** 毎フレーム描き直す（カーソルが点滅し、スクロールで画素が変わるため）。 */
  override tick(): void {
    if (this.status !== 'ready') return
    this.browser.render()
    this.markDirty()
    // HUD に現在のページ／フォーカス中の入力欄を出す。setDetail は文字列が変わった
    // ときだけ通知するので、毎フレームの React 更新にはならない。
    this.setDetail(this.detailLine())
  }

  override pointer(event: ScreenPointerEvent): void {
    if (this.status !== 'ready') return
    this.browser.pointer(event.type, event.x, event.y, event.button, event.clickCount)
    this.markDirty()
  }

  override wheel(
    dx: number,
    dy: number,
    x: number,
    y: number,
    _modifiers: ScreenModifiers,
  ): void {
    if (this.status !== 'ready') return
    this.browser.wheel(dx, dy, x, y)
    this.markDirty()
  }

  override key(event: ScreenKeyEvent): void {
    if (this.status !== 'ready') return
    this.browser.key(event.type, event.key, event.charCode)
    this.markDirty()
  }

  override insertText(text: string): void {
    if (this.status !== 'ready') return
    this.browser.insertText(text)
    this.markDirty()
  }

  override cursorKind(x: number, y: number): CursorKind {
    return this.status === 'ready' ? this.browser.cursorKind(x, y) : 'default'
  }

  get currentUrl(): string {
    return this.browser.currentUrl
  }

  /** 住所欄からの遷移。 */
  navigate(input: string): void {
    if (this.status !== 'ready') return
    this.browser.navigate(input)
    this.markDirty()
  }

  private detailLine(): string {
    return `内蔵 canvas ブラウザ · ${this.browser.statusLine()}`
  }
}
