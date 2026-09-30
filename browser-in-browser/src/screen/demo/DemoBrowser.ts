import type { CursorKind } from '../types'

/**
 * 2D canvas に描くだけの、小さなブラウザ。
 *
 * これが存在する理由: wasm エンジンは約 233MB の成果物で Linux でしかビルドできず、
 * npm 依存として同梱できない。代わりにこの内蔵ブラウザを用意することで、
 * canvas → CanvasTexture → レイキャスト → 入力転送 というエンジンとまったく同じ経路を
 * 今日から本物として動かせる。3D 画面も CRT シェーダも入力変換も、これで検証できる。
 *
 * 意図的に小さい: クロームバー、スクロールする文書、リンク、テキスト欄、スクロール。
 * 本物のエンジンとは何の関係もない。
 */

export type { CursorKind }

type Block =
  | { kind: 'h1'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'muted'; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'swatch'; color: string; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'input'; id: string; placeholder: string }
  | { kind: 'rule' }

interface Page {
  title: string
  blocks: Block[]
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface HitRegion extends Rect {
  cursor: CursorKind
  action: () => void
  /**
   * 文書の先頭から測った領域の上端。`y`（canvas 座標）と違いスクロールしても
   * 変わらないので、ホバー判定にはこちらを使う。
   */
  documentY: number
}

const inside = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h

const HOME = 'about:home'
const FONT_STACK =
  '-apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", ui-sans-serif, system-ui, sans-serif'
const UI_FONT = `13px ${FONT_STACK}`
const BODY_FONT = `15px ${FONT_STACK}`
const LINK_FONT = `500 15px ${FONT_STACK}`
const H1_FONT = `600 26px ${FONT_STACK}`
const MONO_FONT = '13px ui-monospace, SFMono-Regular, Menlo, monospace'

const CHROME_HEIGHT = 46
const SCROLLBAR_WIDTH = 10
const PADDING_X = 26
const LINE_HEIGHT = 25

const PAGES: Record<string, Page> = {
  [HOME]: {
    title: 'スタートページ',
    blocks: [
      { kind: 'h1', text: 'これはブラウザの中で動くコンピュータ' },
      {
        kind: 'p',
        text: '画面のすべての画素はいったん canvas に描かれ、その canvas がテクスチャとして 3D モニタのわずかに湾曲したガラスに貼られます。クリックは、レイが当たった位置の UV を canvas の座標に逆算しているだけです。',
      },
      { kind: 'rule' },
      { kind: 'h1', text: '試せること' },
      { kind: 'link', text: '入力と IME →', href: 'demo://input' },
      { kind: 'link', text: '長いページのスクロール →', href: 'demo://scroll' },
      { kind: 'link', text: '組版と色 →', href: 'demo://type' },
      { kind: 'link', text: '存在しないアドレス →', href: 'demo://nothing-here' },
      { kind: 'rule' },
      {
        kind: 'muted',
        text: 'いまこの画面を描いているのは内蔵の canvas ブラウザです。wasm エンジンを接続すると、同じ入力経路が本物の Gecko を動かします。',
      },
      { kind: 'code', text: 'texture = new THREE.CanvasTexture(canvas)' },
    ],
  },
  'demo://input': {
    title: '入力と IME',
    blocks: [
      { kind: 'h1', text: '入力の転送' },
      {
        kind: 'p',
        text: '下の入力欄をクリックして、実際のキーボードで打ってみてください。キーは window 層で捕捉されてここへ転送されます——日本語 IME の一括確定も含めて。',
      },
      { kind: 'input', id: 'a', placeholder: 'ここに入力してみてください' },
      { kind: 'input', id: 'b', placeholder: '2 つめの入力欄（クリックでフォーカス移動）' },
      { kind: 'rule' },
      { kind: 'li', text: 'Backspace で削除、Enter で確定、Escape でフォーカス解除' },
      { kind: 'li', text: 'Tab は奪っているので 3D 画面の外へは出ません' },
      { kind: 'muted', text: '住所欄も編集できます：クリックして demo://type と入力し、Enter。' },
    ],
  },
  'demo://scroll': {
    title: '長いページ',
    blocks: [
      { kind: 'h1', text: 'スクロール' },
      {
        kind: 'p',
        text: 'ホイールも同じく 3D のレイから転送されます。下までスクロールすると、右側に現在位置の表示が出ます。',
      },
      ...Array.from({ length: 16 }, (_, index) => ({
        kind: 'p' as const,
        text: `第 ${index + 1} 段落。モニタのガラスは湾曲しているので、テクスチャは幾何の曲率で引き伸ばされます。ただしレイが当たるのは同じ曲面なので、クリック位置はずれません。`,
      })),
      { kind: 'link', text: 'スタートページヘ戻る →', href: HOME },
    ],
  },
  'demo://type': {
    title: '組版と色',
    blocks: [
      { kind: 'h1', text: 'CRT 上の組版' },
      {
        kind: 'p',
        text: '走査線、シャドウマスク、樽型の減光、ガラス面のハイライト、わずかな色ずれは、すべて画面マテリアル側の後処理です。文字そのものは画素単位でくっきりしています。',
      },
      { kind: 'swatch', color: '#e5484d', text: '赤' },
      { kind: 'swatch', color: '#46a758', text: '緑' },
      { kind: 'swatch', color: '#3e63dd', text: '青' },
      { kind: 'code', text: 'const texture = new THREE.CanvasTexture(canvas)' },
      { kind: 'rule' },
      { kind: 'link', text: 'スタートページヘ戻る →', href: HOME },
    ],
  },
}

function fallbackPage(url: string): Page {
  return {
    title: 'ページが見つかりません',
    blocks: [
      { kind: 'h1', text: 'このアドレスは存在しません' },
      { kind: 'code', text: url || '(空)' },
      {
        kind: 'p',
        text: '内蔵の canvas ブラウザには数ページしかありません。本当のネットワークを見るには、wasm エンジンを接続して WISP プロキシを設定してください。',
      },
      { kind: 'link', text: 'スタートページヘ戻る →', href: HOME },
    ],
  }
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return HOME
  if (PAGES[value]) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `demo://${value}`
}

export class DemoBrowser {
  private readonly ctx: CanvasRenderingContext2D
  private readonly canvas: HTMLCanvasElement

  private url = HOME
  private history: string[] = [HOME]
  private historyIndex = 0

  private addressFocused = false
  private addressSelected = false
  private addressDraft = ''

  private fields = new Map<string, string>([
    ['a', ''],
    ['b', ''],
  ])
  private focusedField: string | null = null

  private scrollY = 0
  private documentHeight = 0
  private viewportHeight = 0

  /** 前フレームで作ったヒット領域。canvas 座標へ変換済み。 */
  private hits: HitRegion[] = []
  private hovered: HitRegion | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('DemoBrowser: 2D コンテキストを取得できません')
    this.ctx = ctx
  }

  get title(): string {
    return (PAGES[this.url] ?? fallbackPage(this.url)).title
  }

  get currentUrl(): string {
    return this.url
  }

  statusLine(): string {
    const field = this.focusedField ? ` · 入力欄 ${this.focusedField}` : ''
    return `${this.title} · ${this.url}${field}`
  }

  // ---- 入力 --------------------------------------------------------------

  pointer(
    type: 'move' | 'down' | 'up',
    x: number,
    y: number,
    _button: number,
    _clickCount: number,
  ): void {
    if (type === 'move') {
      this.hovered = y >= CHROME_HEIGHT ? this.hitAt(x, y) : null
      return
    }
    if (type !== 'down') return
    if (this.canvas.width === 0) return

    if (y < CHROME_HEIGHT) {
      this.handleChromeClick(x, y)
      return
    }

    // 文書内のクリックは、まずクロームや入力欄からフォーカスを外す。
    this.addressFocused = false
    this.focusedField = null
    const hit = this.hitAt(x, y)
    if (hit) hit.action()
  }

  wheel(_dx: number, dy: number, _x: number, _y: number): void {
    const max = Math.max(0, this.documentHeight - this.viewportHeight)
    this.scrollY = clamp(this.scrollY + dy, 0, max)
  }

  key(type: 'down' | 'up', key: string, codePoint: number): void {
    if (type !== 'down') return
    const text = codePoint > 0x1f && codePoint !== 0x7f ? String.fromCodePoint(codePoint) : ''

    if (key === 'Escape') {
      this.addressFocused = false
      this.focusedField = null
      return
    }

    if (this.addressFocused) {
      if (key === 'Enter') {
        this.navigate(this.addressDraft)
        this.addressFocused = false
        this.addressDraft = ''
        return
      }
      if (key === 'Backspace') {
        this.addressDraft = this.addressSelected ? '' : this.addressDraft.slice(0, -1)
        this.addressSelected = false
        return
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const next = this.historyIndex + (key === 'ArrowDown' ? 1 : -1)
        if (next >= 0 && next < this.history.length) {
          this.historyIndex = next
          this.addressDraft = this.history[next]
          this.addressSelected = true
        }
        return
      }
      if (text) {
        this.addressDraft = this.addressSelected ? text : this.addressDraft + text
        this.addressSelected = false
      }
      return
    }

    if (this.focusedField) {
      const value = this.fields.get(this.focusedField) ?? ''
      if (key === 'Backspace') this.fields.set(this.focusedField, value.slice(0, -1))
      else if (key === 'Enter') this.focusedField = null
      else if (text) this.fields.set(this.focusedField, value + text)
      return
    }

    if (key === 'ArrowDown') this.wheel(0, 70, 0, 0)
    else if (key === 'ArrowUp') this.wheel(0, -70, 0, 0)
    else if (key === 'PageDown') this.wheel(0, this.viewportHeight * 0.85, 0, 0)
    else if (key === 'PageUp') this.wheel(0, -this.viewportHeight * 0.85, 0, 0)
  }

  insertText(text: string): void {
    if (this.addressFocused) {
      this.addressDraft = this.addressSelected ? text : this.addressDraft + text
      this.addressSelected = false
      return
    }
    if (this.focusedField) {
      this.fields.set(this.focusedField, (this.fields.get(this.focusedField) ?? '') + text)
    }
  }

  cursorKind(x: number, y: number): CursorKind {
    if (y < CHROME_HEIGHT) {
      return inside(this.addressRect(), x, y) ? 'text' : 'pointer'
    }
    return this.hitAt(x, y)?.cursor ?? 'default'
  }

  // ---- 遷移 --------------------------------------------------------------

  /** アドレス欄からの遷移。HUD から呼ばれる。 */
  navigate(raw: string): void {
    const url = normalizeUrl(raw)
    if (!url || url === this.url) return
    this.history = this.history.slice(0, this.historyIndex + 1)
    this.history.push(url)
    this.historyIndex = this.history.length - 1
    this.url = url
    this.scrollY = 0
    this.focusedField = null
    this.hovered = null
    this.hits = []
  }

  private go(delta: number): void {
    const next = this.historyIndex + delta
    if (next < 0 || next >= this.history.length) return
    this.historyIndex = next
    this.url = this.history[next]
    this.scrollY = 0
    this.hits = []
  }

  private handleChromeClick(x: number, y: number): void {
    if (inside(this.addressRect(), x, y)) {
      this.addressFocused = true
      this.focusedField = null
      this.addressDraft = this.url
      this.addressSelected = true
      return
    }
    this.addressFocused = false
    const buttons = this.chromeButtons()
    if (inside(buttons.back, x, y)) this.go(-1)
    else if (inside(buttons.forward, x, y)) this.go(1)
    else if (inside(buttons.reload, x, y)) this.scrollY = 0
  }

  // ---- レイアウト補助 ------------------------------------------------------

  private get width(): number {
    return this.canvas.width
  }

  private get height(): number {
    return this.canvas.height
  }

  private chromeButtons(): Record<'back' | 'forward' | 'reload', Rect> {
    const cy = CHROME_HEIGHT / 2
    return {
      back: { x: 14, y: cy - 14, w: 28, h: 28 },
      forward: { x: 46, y: cy - 14, w: 28, h: 28 },
      reload: { x: 78, y: cy - 14, w: 28, h: 28 },
    }
  }

  private addressRect(): Rect {
    return { x: 112, y: 9, w: Math.max(80, this.width - 126), h: 28 }
  }

  private hitAt(x: number, y: number): HitRegion | null {
    for (let index = this.hits.length - 1; index >= 0; index -= 1) {
      const region = this.hits[index]
      if (inside(region, x, y)) return region
    }
    return null
  }

  /** 空白で折れるならそこで、無理なら文字単位で折る貪欲法。 */
  private wrap(text: string, maxWidth: number, font: string): string[] {
    const ctx = this.ctx
    ctx.font = font
    const lines: string[] = []
    let line = ''
    for (const char of Array.from(text)) {
      const candidate = line + char
      if (line && ctx.measureText(candidate).width > maxWidth) {
        const breakAt = char === ' ' ? line.length : line.lastIndexOf(' ')
        if (breakAt > 0 && breakAt < line.length - 1) {
          lines.push(line.slice(0, breakAt))
          line = `${line.slice(breakAt + 1)}${char}`
        } else {
          lines.push(line)
          line = char === ' ' ? '' : char
        }
      } else {
        line = candidate
      }
    }
    if (line.trim()) lines.push(line)
    return lines.length ? lines : ['']
  }

  // ---- 描画 --------------------------------------------------------------

  /** 1 フレーム全体を描く。カーソルが点滅するので毎アニメーションフレーム動く。 */
  render(): void {
    const ctx = this.ctx
    const blink = (performance.now() / 530) % 2 > 1

    ctx.save()
    ctx.clearRect(0, 0, this.width, this.height)

    this.viewportHeight = Math.max(0, this.height - CHROME_HEIGHT)
    this.drawDocument(blink)
    this.drawChrome(blink)

    ctx.restore()
  }

  private drawDocument(blink: boolean): void {
    const ctx = this.ctx
    const documentWidth = this.width - SCROLLBAR_WIDTH
    const page = PAGES[this.url] ?? fallbackPage(this.url)
    const maxWidth = documentWidth - PADDING_X * 2
    const pending: HitRegion[] = []

    ctx.fillStyle = '#fbfbfd'
    ctx.fillRect(0, CHROME_HEIGHT, this.width, this.height - CHROME_HEIGHT)

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, CHROME_HEIGHT, documentWidth, this.viewportHeight)
    ctx.clip()
    ctx.translate(0, CHROME_HEIGHT - this.scrollY)

    // レイアウトは文書座標で進める。`y` は次のブロックの上端で、文書の先頭から測る
    // （scrollY = 0 のとき画面上では CHROME_HEIGHT の位置にある）。
    let y = 34

    for (const block of page.blocks) {
      switch (block.kind) {
        case 'h1': {
          ctx.font = H1_FONT
          ctx.fillStyle = '#14141a'
          ctx.textBaseline = 'alphabetic'
          for (const line of this.wrap(block.text, maxWidth, H1_FONT)) {
            ctx.fillText(line, PADDING_X, y + 20)
            y += 34
          }
          y += 10
          break
        }

        case 'p':
        case 'muted': {
          ctx.font = BODY_FONT
          ctx.fillStyle = block.kind === 'muted' ? '#6b6b78' : '#2a2a33'
          for (const line of this.wrap(block.text, maxWidth, BODY_FONT)) {
            ctx.fillText(line, PADDING_X, y + 12)
            y += LINE_HEIGHT
          }
          y += 12
          break
        }

        case 'li': {
          ctx.font = BODY_FONT
          ctx.fillStyle = '#2a2a33'
          ctx.fillText('·', PADDING_X + 2, y + 12)
          for (const line of this.wrap(block.text, maxWidth - 18, BODY_FONT)) {
            ctx.fillText(line, PADDING_X + 18, y + 12)
            y += LINE_HEIGHT
          }
          y += 6
          break
        }

        case 'code': {
          ctx.font = MONO_FONT
          const lines = this.wrap(block.text, maxWidth - 24, MONO_FONT)
          const boxHeight = lines.length * 21 + 18
          roundRect(ctx, PADDING_X, y, maxWidth, boxHeight, 8)
          ctx.fillStyle = '#eef0f6'
          ctx.fill()
          ctx.fillStyle = '#3a3a52'
          lines.forEach((line, index) => {
            ctx.fillText(line, PADDING_X + 12, y + 24 + index * 21)
          })
          y += boxHeight + 18
          break
        }

        case 'swatch': {
          ctx.fillStyle = block.color
          roundRect(ctx, PADDING_X + 1, y + 3, 14, 14, 4)
          ctx.fill()
          ctx.font = BODY_FONT
          ctx.fillStyle = '#2a2a33'
          ctx.fillText(`${block.text}  ${block.color}`, PADDING_X + 26, y + 15)
          y += 30
          break
        }

        case 'link': {
          ctx.font = LINK_FONT
          const labelWidth = ctx.measureText(block.text).width
          const region = { x: PADDING_X - 6, y: y - 6, w: labelWidth + 12, h: 30 }
          const hovered = this.hovered?.documentY === region.y
          ctx.fillStyle = hovered ? '#1b48d6' : '#2f5bea'
          ctx.fillText(block.text, PADDING_X, y + 14)
          ctx.fillRect(PADDING_X, y + 18, labelWidth, 1)

          const href = block.href
          pending.push({
            ...region,
            documentY: region.y,
            cursor: 'pointer',
            action: () => this.navigate(href),
          })

          y += 36
          break
        }

        case 'input': {
          const region = { x: PADDING_X, y, w: Math.min(maxWidth, 460), h: 38 }
          const id = block.id
          const value = this.fields.get(id) ?? ''
          const focused = this.focusedField === id

          roundRect(ctx, region.x, region.y, region.w, region.h, 8)
          ctx.fillStyle = '#ffffff'
          ctx.fill()
          ctx.strokeStyle = focused ? '#2f5bea' : '#d3d3dc'
          ctx.lineWidth = focused ? 2 : 1
          ctx.stroke()

          ctx.font = BODY_FONT
          ctx.fillStyle = value ? '#1a1a22' : '#9b9ba8'
          ctx.fillText(value || block.placeholder, region.x + 12, region.y + 25)
          if (focused && blink) {
            const caretX = region.x + 12 + ctx.measureText(value).width + 1
            ctx.fillStyle = '#1a1a22'
            ctx.fillRect(caretX, region.y + 9, 1.5, region.h - 18)
          }

          pending.push({
            ...region,
            documentY: region.y,
            cursor: 'text',
            action: () => {
              this.focusedField = id
              this.addressFocused = false
            },
          })
          y += region.h + 16
          break
        }

        case 'rule': {
          ctx.strokeStyle = '#e3e3ea'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(PADDING_X, y + 8.5)
          ctx.lineTo(documentWidth - PADDING_X, y + 8.5)
          ctx.stroke()
          y += 28
          break
        }
      }
    }

    ctx.restore()

    this.documentHeight = y + 40

    // 以降、ヒット領域は canvas 座標になる。上の transform が文書を
    // (CHROME_HEIGHT - scrollY) だけ下へずらしているため。
    const offset = CHROME_HEIGHT - this.scrollY
    this.hits = pending
      .map((region) => ({ ...region, y: region.y + offset }))
      .filter((hit) => hit.y + hit.h > CHROME_HEIGHT && hit.y < this.height)

    this.drawScrollbar()
  }

  private drawScrollbar(): void {
    const max = Math.max(0, this.documentHeight - this.viewportHeight)
    if (max <= 0) return
    const ctx = this.ctx
    const trackY = CHROME_HEIGHT
    const trackHeight = this.viewportHeight
    const thumbHeight = Math.max(36, (this.viewportHeight / this.documentHeight) * trackHeight)
    const thumbY = trackY + (this.scrollY / max) * (trackHeight - thumbHeight)

    ctx.fillStyle = 'rgba(0,0,0,0.05)'
    ctx.fillRect(this.width - SCROLLBAR_WIDTH, trackY, SCROLLBAR_WIDTH, trackHeight)
    roundRect(ctx, this.width - SCROLLBAR_WIDTH + 2, thumbY, SCROLLBAR_WIDTH - 4, thumbHeight, 3)
    ctx.fillStyle = 'rgba(0,0,0,0.26)'
    ctx.fill()
  }

  private drawChrome(blink: boolean): void {
    const ctx = this.ctx
    const gradient = ctx.createLinearGradient(0, 0, 0, CHROME_HEIGHT)
    gradient.addColorStop(0, '#2d2d36')
    gradient.addColorStop(1, '#202028')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, this.width, CHROME_HEIGHT)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(0, CHROME_HEIGHT - 1, this.width, 1)

    const buttons = this.chromeButtons()
    this.drawChromeButton(buttons.back, '‹', this.historyIndex > 0)
    this.drawChromeButton(buttons.forward, '›', this.historyIndex < this.history.length - 1)
    this.drawChromeButton(buttons.reload, '⟳', true)

    const rect = this.addressRect()
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 7)
    ctx.fillStyle = this.addressFocused ? '#14141a' : '#1b1b21'
    ctx.fill()
    ctx.strokeStyle = this.addressFocused ? '#5b7cfa' : '#32323c'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.font = UI_FONT
    ctx.textBaseline = 'middle'
    const text = this.addressFocused ? this.addressDraft : this.url
    ctx.fillStyle = this.addressFocused ? '#e8e8ee' : '#9a9aa6'
    const textX = rect.x + 11
    const textY = rect.y + rect.h / 2 + 1

    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x + 2, rect.y, rect.w - 4, rect.h)
    ctx.clip()
    ctx.fillText(text, textX, textY)
    if (this.addressFocused && blink) {
      const caretX = textX + (this.addressSelected ? 0 : ctx.measureText(text).width) + 1
      ctx.fillStyle = '#8ea9ff'
      ctx.fillRect(caretX, rect.y + 6, 1.5, rect.h - 12)
      if (this.addressSelected) {
        ctx.fillStyle = 'rgba(91,124,250,0.35)'
        ctx.fillRect(textX, rect.y + 5, ctx.measureText(text).width + 2, rect.h - 10)
      }
    }
    ctx.restore()
    ctx.textBaseline = 'alphabetic'
  }

  private drawChromeButton(rect: Rect, glyph: string, enabled: boolean): void {
    const ctx = this.ctx
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 7)
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    ctx.fill()

    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    ctx.strokeStyle = enabled ? '#c8c8d4' : '#4e4e58'
    ctx.fillStyle = enabled ? '#c8c8d4' : '#4e4e58'
    ctx.lineWidth = 1.6

    if (glyph === '‹' || glyph === '›') {
      const dir = glyph === '‹' ? -1 : 1
      ctx.beginPath()
      ctx.moveTo(cx + dir * 3, cy - 5)
      ctx.lineTo(cx - dir * 3, cy)
      ctx.lineTo(cx + dir * 3, cy + 5)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(cx, cy, 5.5, -0.6, Math.PI * 1.6)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx + 3.4, cy - 5)
      ctx.lineTo(cx + 5.8, cy - 6.4)
      ctx.lineTo(cx + 5.2, cy - 3.6)
      ctx.closePath()
      ctx.fill()
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
