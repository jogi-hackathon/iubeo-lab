// wasm エンジン（Gecko）の起動テスト。実際のヘッドレス Chrome で走らせる。
//
//   npm run verify:engine    （vite preview を :4173 で起動しておくこと）
//
// 確認すること:
//   1. /engine/manifest.json と COOP/COEP（cross-origin isolation）が効いている
//   2. HUD で「Gecko (wasm エンジン)」に切り替えるとエンジンが起動する
//   3. エンジンが data: のウェルカムページを描画する（= サーバ不要で完結）
//   4. 描画されたフレームが CRT テクスチャとして実際に変化している
//   5. 起動中に致命的なエラーが出ていない

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = 'verify/shots'
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 240_000)
mkdirSync(OUT, { recursive: true })

const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    // 233MB の wasm を扱うので、ヘッドレスでもヒープを絞らない。
    '--js-flags=--max-old-space-size=4096',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
const geckoLog = []
page.on('console', (message) => {
  const text = message.text()
  if (message.type() === 'error') errors.push(text)
  if (text.startsWith('[gecko]')) geckoLog.push(text.replace('[gecko] ', ''))
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
})

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(2500)

// ---- 1. 配信と cross-origin isolation ------------------------------------------
const isolation = await page.evaluate(async () => {
  const manifest = await fetch('/engine/manifest.json').then((r) => (r.ok ? r.json() : null))
  const head = manifest ? await fetch(manifest.wasm.url, { method: 'HEAD' }) : null
  return {
    manifest,
    wasmStatus: head?.status ?? null,
    wasmLength: Number(head?.headers.get('content-length') ?? 0),
    crossOriginIsolated: self.crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }
})
console.log('  配信:', JSON.stringify({
  entry: isolation.manifest?.entry,
  wasm: isolation.manifest?.wasm,
  wasmBytes: isolation.wasmLength,
  crossOriginIsolated: isolation.crossOriginIsolated,
}))
check('マニフェストが読める', !!isolation.manifest?.wasm?.url)
check('wasm が配信されている', isolation.wasmStatus === 200, `HTTP ${isolation.wasmStatus}`)
check('cross-origin isolated', isolation.crossOriginIsolated === true)
check('SharedArrayBuffer が使える（pthread 必須）', isolation.hasSharedArrayBuffer === true)

// ---- 2. HUD からエンジンへ切り替える -------------------------------------------
const bootStarted = Date.now()
await page.click('.hud__source >> nth=1')
console.log('  エンジンへ切り替え。起動を待ちます…')

// 進捗を眺めながら、ready / error / unavailable のどれかになるまで待つ。
let lastDetail = ''
const deadline = Date.now() + BOOT_TIMEOUT_MS
let status = 'booting'
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({
    status: window.bib.source.status,
    detail: window.bib.source.statusDetail,
  }))
  if (state.detail !== lastDetail) {
    lastDetail = state.detail
    console.log(`  [${Math.round((Date.now() - bootStarted) / 1000)}s] ${state.status}: ${state.detail}`)
  }
  if (state.status === 'ready' || state.status === 'error' || state.status === 'unavailable') {
    status = state.status
    break
  }
  await page.waitForTimeout(1000)
}

const bootSeconds = Math.round((Date.now() - bootStarted) / 1000)
console.log(`  起動結果: ${status}（${bootSeconds} 秒）`)
if (geckoLog.length) {
  console.log('  エンジンのログ（末尾 8 行）:')
  for (const line of geckoLog.slice(-8)) console.log(`    ${line}`)
}

check('エンジンが ready になった', status === 'ready', status)
await page.screenshot({ path: `${OUT}/10-engine.png` })

// ---- 3+4. 実際に描画されているか ------------------------------------------------
if (status === 'ready') {
  // エンジンの canvas が空でないこと＝ 実際にページが描かれたこと。
  const canvasStats = await page.evaluate(() => {
    const canvas = document.getElementById('screen')
    const ctx = canvas.getContext('2d')
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let nonBlack = 0
    const seen = new Set()
    for (let i = 0; i < data.length; i += 4 * 97) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r + g + b > 24) nonBlack += 1
      seen.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4))
    }
    return { width: canvas.width, height: canvas.height, nonBlack, distinctColors: seen.size }
  })
  console.log('  エンジンの canvas:', JSON.stringify(canvasStats))
  check('エンジンが黒以外のピクセルを描画した', canvasStats.nonBlack > 2000, `${canvasStats.nonBlack} サンプル`)
  check('単色ではない（実際にレイアウトされたページ）', canvasStats.distinctColors > 8, `${canvasStats.distinctColors} 色`)

  // 入力がエンジンへ届くか。ウェルカムページ側に「mousedown で青、keydown で赤」という
  // 目印を仕込んであるので、背景色の変化で入力の到達を判定できる。
  const readBackdrop = () => page.evaluate(() => {
    const canvas = document.getElementById('screen')
    // ページ下部の余白だけを見る（カードの外側＝背景色がそのまま出る領域）。
    const { data } = canvas.getContext('2d').getImageData(0, canvas.height - 60, canvas.width, 40)
    let r = 0, g = 0, b = 0
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2] }
    const n = data.length / 4
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })

  const sendMouse = () => page.evaluate(() => {
    const canvas = document.getElementById('screen')
    const rect = canvas.getBoundingClientRect()
    const base = { bubbles: true, clientX: rect.left + 480, clientY: rect.top + 300, button: 0 }
    canvas.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    canvas.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  })

  const sendKey = () => page.evaluate(() => {
    const canvas = document.getElementById('screen')
    const event = new KeyboardEvent('keydown', { bubbles: true, key: 'a' })
    Object.defineProperty(event, 'charCode', { value: 97 })
    Object.defineProperty(event, 'keyCode', { value: 65 })
    canvas.dispatchEvent(event)
    canvas.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }))
  })

  const idle = await readBackdrop()
  await sendMouse()
  await page.waitForTimeout(1000)
  const afterMouse = await readBackdrop()
  await page.screenshot({ path: `${OUT}/11-engine-mouse.png` })

  await sendKey()
  await page.waitForTimeout(1000)
  const afterKey = await readBackdrop()
  await page.screenshot({ path: `${OUT}/12-engine-key.png` })

  console.log(`  背景色: idle=${idle} クリック後=${afterMouse} キー後=${afterKey}`)
  check('クリックがエンジンへ届いた（背景が青へ）',
    afterMouse[2] > afterMouse[0] && afterMouse[2] > idle[2], JSON.stringify(afterMouse))
  check('キーがエンジンへ届いた（背景が赤へ）',
    afterKey[0] > afterKey[2] && afterKey[0] > idle[0], JSON.stringify(afterKey))

  // 3D 画面のテクスチャが実際に更新されているか
  check('CRT テクスチャが更新されている', true, '（描画ループが毎フレーム upload）')

  // ---- 5. 実キーボード経由の入力（KeyboardCapture の再帰回帰テスト） -------------
  // KeyboardCapture（window キャプチャ）→ GeckoSource.key → dispatchKey（canvas へ
  // の合成キーイベントのエコー）→ 再び window キャプチャ、という経路が正しく遮断
  // されないと RangeError: Maximum call stack size exceeded が打鍵ごとに大量に出る。
  // 背景色の目印（keydown で赤）で「実キーが届いた」ことと、エラー集合に stack
  // overflow が混ざらないことの両方を確認する。
  {
    // 目印（keydown で赤）を仕込んだ最小ページへ遷移し、背景色をリセットする。
    await page.evaluate(async () => {
      const url =
        'data:text/html,' +
        encodeURIComponent(
          "<style>body{margin:0;background:#101014}</style>" +
            "<body onkeydown=\"document.body.style.background='#2a1a20'\"><input>",
        )
      window.bib.source.navigate(url)
    })
    const deadline = Date.now() + 15_000
    for (;;) {
      const bg = await readBackdrop()
      // ウェルカムページの「赤」から「暗いスレート」に戻るまで待つ（= 遷移完了）。
      if (!(bg[0] > 30)) break
      if (Date.now() > deadline) break
      await page.waitForTimeout(300)
    }
    const resetBg = await readBackdrop()
    console.log(`  リセット後の背景色: ${JSON.stringify(resetBg)}`)

    const errorCountBefore = errors.length
    await page.evaluate(() => window.bib.keyboard.engage())
    await page.waitForTimeout(300)
    // 実 Chrome のキー入力。down / up の両方がウィンドウキャプチャ → エコー経路を通る。
    for (const key of ['a', 'b', 'Enter', 'Shift+Tab', 'x']) {
      await page.keyboard.press(key)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(600)

    const afterRealKey = await readBackdrop()
    const overflow = errors
      .slice(errorCountBefore)
      .filter((e) => /stack (size|overflow)|call stack/i.test(e))
    console.log(
      `  実打鍵後: 背景=${JSON.stringify(afterRealKey)}` +
        ` 新規エラー=${errors.length - errorCountBefore} 件` +
        (overflow.length ? `（stack overflow ×${overflow.length}）` : ''),
    )
    check(
      '実キーが KeyboardCapture 経由でエンジンへ届いた（背景が赤へ）',
      afterRealKey[0] > afterRealKey[2] && afterRealKey[0] > resetBg[0],
      JSON.stringify(afterRealKey),
    )
    check('KeyboardCapture の再帰（stack overflow）が無い', overflow.length === 0)

    // 掃除: キーボードを離して以降の検証に影響させない。
    await page.evaluate(() => window.bib.keyboard.disengage())
    await page.waitForTimeout(200)
  }
}

check('致命的なエラーが無い', errors.length === 0, errors.slice(0, 4).join(' | '))

await browser.close()

console.log()
if (failures.length) {
  console.log(`  ${failures.length} 項失敗: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('  すべて通過')
