import * as THREE from 'three'
import { SYNTHETIC_KEY } from './types'
import type {
  CursorKind,
  ScreenKeyEvent,
  ScreenModifiers,
  ScreenPointerEvent,
  ScreenSource,
  ScreenStatus,
} from './types'

/**
 * 「ブラウザを 1 枚の canvas に描き、それをテクスチャとして読む」ための基底クラス。
 *
 * 正しさに関わる点が 2 つある:
 *
 *  1. canvas はレイアウトされ、フォーカス可能な状態のままにしておく必要がある。エンジンは
 *     canvas 自身にリスナーを付け、mousedown で `canvas.focus()` を呼ぶ。
 *     `getBoundingClientRect()` と `focus()` はどちらも描画されたボックスを必要とするので、
 *     `display: none` ではなく `position: fixed` で画面外に追い出し、実際の画素サイズを保ち、
 *     `opacity: 0` で見えなくする。
 *  2. CSS サイズとバッキングストアのサイズを一致させること。エンジンはクライアント座標を
 *     `(clientX - rect.left) * (W / rect.width)` で canvas 画素に変換するため、CSS で
 *     拡大縮小しているとすべてのクリックが静かにずれる。
 */
export abstract class CanvasScreenSource implements ScreenSource {
  abstract readonly id: string
  abstract readonly label: string
  abstract readonly note: string

  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture

  status: ScreenStatus = 'idle'
  statusDetail = ''
  onStatusChange?: (status: ScreenStatus, detail: string) => void
  onRepaint?: () => void

  protected dirty = true
  protected disposed = false
  private host: HTMLElement
  private frame: HTMLDivElement

  constructor(host: HTMLElement, width: number, height: number, canvasId: string) {
    this.host = host

    const frame = document.createElement('div')
    frame.style.cssText = [
      'position:fixed',
      'left:-20000px',
      'top:0',
      'opacity:0',
      'pointer-events:none',
      'z-index:-1',
      // ホストページのレイアウト／描画から切り離すための隔離指定。
      'contain:strict',
    ].join(';')
    frame.setAttribute('aria-hidden', 'true')
    this.frame = frame

    const canvas = document.createElement('canvas')
    // 一部のエンジン（gecko.js の GPU モード）は id でサーフェスを探す。ソフトウェア
    // モードでは無害だが、安定した id を持たせておくと契約が明確になる。
    canvas.id = canvasId
    canvas.width = width
    canvas.height = height
    canvas.style.display = 'block'
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.setAttribute('tabindex', '-1')
    this.canvas = canvas

    frame.appendChild(canvas)
    host.appendChild(frame)

    this.texture = new THREE.CanvasTexture(canvas)
    // sRGB → linear の変換は three に任せる（シェーダがサンプリングするときに行われる）。
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.anisotropy = 4
  }

  get width(): number {
    return this.canvas.width
  }

  get height(): number {
    return this.canvas.height
  }

  protected setStatus(status: ScreenStatus, detail = ''): void {
    this.status = status
    this.statusDetail = detail
    if (!this.disposed) this.onStatusChange?.(status, detail)
    this.markDirty()
  }

  /**
   * 状態を変えずに説明文だけ差し替える。表示中のページやフォーカス中の入力欄のように
   * 頻繁に変わるものを出すソースが使う。文字列が実際に変わったときだけ通知するので、
   * 再レンダーの嵐にはならない。
   */
  protected setDetail(detail: string): void {
    if (this.statusDetail === detail || this.disposed) return
    this.statusDetail = detail
    this.onStatusChange?.(this.status, detail)
  }

  markDirty(): void {
    this.dirty = true
    this.onRepaint?.()
  }

  isDirty(): boolean {
    return this.dirty
  }

  /** テクスチャをアップロードした直後に描画ループから呼ばれる。 */
  clearDirty(): void {
    this.dirty = false
  }

  tick(): void {
    /* 自前でアニメーションするソースが上書きする */
  }

  cursorKind(_x: number, _y: number): CursorKind {
    return 'default'
  }

  async resize(width: number, height: number): Promise<void> {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.markDirty()
  }

  /** 合成イベントを投げて本物の DOM イベントパイプラインを駆動したいサブクラス用。 */
  protected dispatchPointer(event: ScreenPointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const type =
      event.type === 'down' ? 'mousedown' : event.type === 'up' ? 'mouseup' : 'mousemove'
    const domEvent = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + event.x,
      clientY: rect.top + event.y,
      screenX: rect.left + event.x,
      screenY: rect.top + event.y,
      button: event.button,
      buttons: event.buttons,
      detail: event.clickCount,
      ...event.modifiers,
    })
    this.canvas.dispatchEvent(domEvent)
  }

  protected dispatchWheel(
    dx: number,
    dy: number,
    x: number,
    y: number,
    modifiers: ScreenModifiers,
  ): void {
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: rect.left + x,
        clientY: rect.top + y,
        deltaX: dx,
        deltaY: dy,
        deltaMode: 0,
        ...modifiers,
      }),
    )
  }

  protected dispatchKey(event: ScreenKeyEvent): void {
    const type = event.type === 'down' ? 'keydown' : 'keyup'
    const domEvent = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: event.key,
      ...event.modifiers,
    })
    // keyCode / charCode はレガシーで KeyboardEventInit の型からは弾かれるが、
    // エンジンは今でもこれを読む。全ブラウザで一致させるため直接定義する。
    Object.defineProperty(domEvent, 'keyCode', { value: event.keyCode, configurable: true })
    Object.defineProperty(domEvent, 'charCode', { value: event.charCode, configurable: true })
    Object.defineProperty(domEvent, 'which', { value: event.keyCode, configurable: true })
    // 合成イベントであることを記す。KeyboardCapture がこのイベントを本物のキーと
    // 勘違いして再転送すると無限再帰になる（stack overflow）ため、目印を付けて
    // そちらで除外してもらう。エンジン側のリスナーには影響しない。
    Object.defineProperty(domEvent, SYNTHETIC_KEY, { value: true, configurable: true })
    this.canvas.dispatchEvent(domEvent)
  }

  // ---- サブクラスが実装するフック ------------------------------------------

  abstract boot(): Promise<void>

  pointer(_event: ScreenPointerEvent): void {}
  wheel(
    _dx: number,
    _dy: number,
    _x: number,
    _y: number,
    _modifiers: ScreenModifiers,
  ): void {}
  key(_event: ScreenKeyEvent): void {}
  insertText(_text: string): void {}

  halt(): void {
    if (this.disposed) return
    this.setStatus('idle', '電源オフ')
  }

  dispose(): void {
    this.disposed = true
    this.texture.dispose()
    this.frame.remove()
    void this.host
  }
}
