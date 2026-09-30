import type * as THREE from 'three'

/**
 * このファイルの要点: 3D 画面は、自分の画素がどこから来るのかを知らない。
 * 今日は wasm エンジンか内蔵 canvas ブラウザ、明日は WebRTC ストリームか
 * HTML-in-Canvas かもしれない。そのすべてが `ScreenSource` を実装する。
 *
 * ソースは canvas を 1 枚持ち、それを THREE.Texture として公開し、入力を
 * *canvas 画素* 座標で受け取る。
 */

export type CursorKind = 'default' | 'pointer' | 'text'
export interface ScreenModifiers {
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

/** ポインタ座標は常に canvas 画素。原点は左上。 */
export interface ScreenPointerEvent {
  type: 'move' | 'down' | 'up'
  x: number
  y: number
  button: number
  buttons: number
  clickCount: number
  modifiers: ScreenModifiers
}

export interface ScreenKeyEvent {
  type: 'down' | 'up'
  key: string
  keyCode: number
  /** 印刷可能なキーでのみ非ゼロ。エンジンではこれが文字を挿入する。 */
  charCode: number
  modifiers: ScreenModifiers
}

export type ScreenStatus = 'idle' | 'booting' | 'ready' | 'error' | 'unavailable'

export interface ScreenSource {
  readonly id: string
  readonly label: string
  /** HUD に出す 1 行の説明。 */
  readonly note: string

  /** CRT シェーダが毎フレームサンプリングする。 */
  readonly texture: THREE.Texture
  readonly width: number
  readonly height: number

  readonly status: ScreenStatus
  readonly statusDetail: string

  onStatusChange?: (status: ScreenStatus, detail: string) => void
  /** サーフェスが変わり、テクスチャの再アップロードが必要になった。 */
  onRepaint?: () => void

  boot(): Promise<void>
  halt(): void
  resize(width: number, height: number): Promise<void>

  pointer(event: ScreenPointerEvent): void
  wheel(dx: number, dy: number, x: number, y: number, modifiers: ScreenModifiers): void
  key(event: ScreenKeyEvent): void
  /** IME の確定や貼り付け用: キーイベントを介さずに文字列を挿入する。 */
  insertText(text: string): void

  /** ソースが持つアニメーションを進める（カーソル点滅、エンジンのフレーム供給）。 */
  tick(): void
  /** 次の描画の前にテクスチャを再アップロードすべきか。 */
  isDirty(): boolean
  /** テクスチャをアップロードした直後に描画ループから呼ばれる。 */
  clearDirty(): void
  /** この canvas 位置で OS カーソルをどう見せるか。 */
  cursorKind(x: number, y: number): CursorKind

  dispose(): void
}

export const NO_MODIFIERS: ScreenModifiers = {
  alt: false,
  ctrl: false,
  shift: false,
  meta: false,
}

/** アドレス欄から遷移できるソース（内蔵ブラウザ、wasm エンジンなど）。 */
export interface NavigableScreenSource extends ScreenSource {
  readonly currentUrl: string
  /** 入力はそのまま解釈してよい（内部でスキームを補完する）。 */
  navigate(input: string): void
}

export function isNavigable(source: ScreenSource): source is NavigableScreenSource {
  return typeof (source as Partial<NavigableScreenSource>).navigate === 'function'
}

/**
 * ソース自身が合成したキーイベントに付ける目印。
 *
 * エンジンへ入力するため canvas に投げたキーイベントは（bubbles:true なので）
 * window のキャプチャ段階を回り、そのまま KeyboardCapture が「本物のキー」と
 * 勘違いすると GeckoSource.key → dispatchKey → （再び）KeyboardCapture という
 * 無限再帰になる。この目印で合成イベントを識別し、再転送を止める。
 */
export const SYNTHETIC_KEY = Symbol('screen.synthetic-key')

/** オフスクリーンのエンジン canvas を入れておくコンテナの DOM id。 */
export const ENGINE_HOST_ID = 'engine-host'
