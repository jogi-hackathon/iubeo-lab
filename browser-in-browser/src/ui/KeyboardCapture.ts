import { SYNTHETIC_KEY } from '../screen/types'
import type { ScreenKeyEvent, ScreenSource } from '../screen/types'

/**
 * 本物のキーボードを借り受け、画面ソースへ流し込む。
 *
 * 設計上の判断:
 *
 *  - リスナーは `window` の**キャプチャ段階**に置き、消費するキーはすべて
 *    `stopPropagation()` する。wasm エンジンが mousedown で `canvas.focus()` を呼ぶため、
 *    特定の要素に付けたリスナーだと「ブラウザ内をクリックした瞬間にキーボードを
 *    失う」ことになるから。
 *  - それでも隠し <textarea> はフォーカスしておく。IME の composition イベントには
 *    本物の編集可能なターゲットが必要だから。`compositionend` で確定文字列ごと
 *    `source.insertText()` に渡す——「候補ウィンドウから『日本語』が確定した」という事実は
 *    キーイベントの列では表現できない。
 *  - `Tab` は飲み込む（そうしないとフォーカスが 3D シーンの外へ抜ける）。ブラウザ自身の
 *    ショートカット（F5/F11/F12、Ctrl+R/W/T/N、devtools）は意図的に触らない。
 *    ページからは阻止できない上に、戦ってもアプリが壊れるだけだから。
 *  - HUD の住所欄など編集可能な要素宛のイベントは素通しする。
 */
export class KeyboardCapture {
  private readonly field: HTMLTextAreaElement
  private source: ScreenSource | null = null
  private active = false
  private composing = false
  private readonly teardown: Array<() => void> = []

  onActiveChange?: (active: boolean) => void

  constructor() {
    const field = document.createElement('textarea')
    field.setAttribute('aria-hidden', 'true')
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('autocomplete', 'off')
    field.setAttribute('autocorrect', 'off')
    field.spellcheck = false
    field.tabIndex = -1
    field.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'border:0',
      'padding:0',
      'margin:0',
      'resize:none',
      'pointer-events:none',
      'z-index:-1',
    ].join(';')
    document.body.appendChild(field)
    this.field = field
    this.listen()
  }

  setSource(source: ScreenSource | null): void {
    this.source = source
  }

  get isActive(): boolean {
    return this.active
  }

  /** キーボードを画面へ流し込み始める。 */
  engage(): void {
    if (this.active) return
    this.active = true
    this.field.focus({ preventScroll: true })
    this.onActiveChange?.(true)
  }

  disengage(): void {
    if (!this.active) return
    this.active = false
    this.composing = false
    this.field.blur()
    this.field.value = ''
    this.onActiveChange?.(false)
  }

  /** IME 用ターゲットを掴み直す。フォーカスが移りうるクリックの後に使う。 */
  refocus(): void {
    if (!this.active) return
    this.field.focus({ preventScroll: true })
  }

  dispose(): void {
    for (const off of this.teardown) off()
    this.teardown.length = 0
    this.field.remove()
  }

  private listen(): void {
    const on = <K extends keyof WindowEventMap>(
      type: K,
      handler: (event: WindowEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      window.addEventListener(type, handler as EventListener, options)
      this.teardown.push(() => window.removeEventListener(type, handler as EventListener))
    }

    on('keydown', (event) => this.handleKeyDown(event), { capture: true })
    on('keyup', (event) => this.handleKeyUp(event), { capture: true })
    on('compositionstart', () => {
      this.composing = true
    })
    on('compositionend', (event) => {
      // 確定した文字列をまとめて渡す。1 キーずつのイベントでは IME の確定を表せない。
      this.composing = false
      if (!this.active || !this.source) return
      event.preventDefault()
      event.stopPropagation()
      const text = event.data ?? ''
      this.field.value = ''
      if (text) this.source.insertText(text)
    })
    on('input', (event) => {
      // 隠し textarea に文字が溜まらないようにする（HUD の入力欄は触らない）。
      if (event.target === this.field) this.field.value = ''
    })
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.active || !this.source) return
    // ソース自身が合成したイベント（エンジン canvas へ投げたエコー）はキャプチャ
    // 段階でここへ戻ってくるだけなので除外する。除外しないと
    // KeyboardCapture → source.key → dispatchKey → KeyboardCapture の無限再帰になる。
    if ((event as unknown as { [SYNTHETIC_KEY]?: boolean })[SYNTHETIC_KEY]) return
    // HUD 側の入力欄（住所欄など）宛なら、こちらは手を出さない。
    if (isEditableTarget(event.target, this.field)) return
    if (isBrowserShortcut(event)) return
    // IME の候補ウィンドウが開いている間は、キーの所有権は IME にある。
    if (this.composing || event.isComposing) return

    if (event.key === 'Escape') {
      this.disengage()
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      event.stopPropagation()
      void this.pasteFromClipboard()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    this.source.key(toScreenKey(event, 'down'))
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (!this.active || !this.source) return
    if ((event as unknown as { [SYNTHETIC_KEY]?: boolean })[SYNTHETIC_KEY]) return
    if (isEditableTarget(event.target, this.field)) return
    if (isBrowserShortcut(event) || this.composing) return
    event.preventDefault()
    event.stopPropagation()
    this.source.key(toScreenKey(event, 'up'))
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text) this.source?.insertText(text)
    } catch {
      // クリップボードの許可が下りなかった。打てる手は無い。コピー／カットは
      // エンジン自身の内部クリップボードが担っている。
    }
  }
}

/** 編集可能な要素（HUD の住所欄など）宛のイベントかを判定する。 */
function isEditableTarget(target: EventTarget | null, own: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target === own) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function toScreenKey(event: KeyboardEvent, type: 'down' | 'up'): ScreenKeyEvent {
  return {
    type,
    key: event.key,
    keyCode: event.keyCode,
    charCode: charCodeOf(event),
    modifiers: {
      alt: event.altKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
  }
}

function charCodeOf(event: KeyboardEvent): number {
  // 修飾キー付きは文字入力ではない（エンジン側もそれを前提にしている）。
  if (event.ctrlKey || event.metaKey || event.altKey) return 0
  if (event.key.length === 1) return event.key.codePointAt(0) ?? 0
  if (event.key === 'Enter') return 13
  if (event.key === 'Tab') return 9
  return 0
}

/**
 * ページからは阻止できないブラウザのショートカット。触らずに通す。
 * （Ctrl+R/W/T/N などは preventDefault しても効かないので、
 * エンジンへ転送せず素通しする方が混乱が少ない。）
 */
function isBrowserShortcut(event: KeyboardEvent): boolean {
  const key = event.key
  const withCommand = event.ctrlKey || event.metaKey

  if (key === 'F5' || key === 'F11' || key === 'F12') return true
  if (withCommand && event.shiftKey && ['I', 'J', 'C'].includes(key.toUpperCase())) return true
  if (withCommand && ['r', 'l', 't', 'n', 'w'].includes(key.toLowerCase())) return true
  if (withCommand && key === 'F5') return true
  return false
}
