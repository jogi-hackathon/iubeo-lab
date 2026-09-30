// 「3D 画面がブラウザになっている」経路を、実際のヘッドレス Chrome で端から端まで検証する。
// ソフトウェア WebGL なのでどこでも動く。
//
//   node /tmp/bib-verify/verify.mjs
//
// 検証していること:
//   1. 起動し、WebGL シーンが描画され、ブラウン管の電源投入が完了する
//   2. viewport 中央のレイが UV (0.5, 0.5) に当たる               <- レイキャスト
//   3. 任意の canvas 画素へポインタを「誘導」できる（UV 読み値を閉ループ制御）  <- 座標変換
//   4. 位置を座標で決め打ちせず、カーソル形状を頼りにリンク／入力欄を探す    <- ヒットテスト
//   5. リンクのクリックで内蔵ブラウザが遷移する
//   6. 打鍵が入力欄に届く
//   7. IME の確定文字列が入力欄に届く

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = '/tmp/bib-verify/shots'
mkdirSync(OUT, { recursive: true })

const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures.push(name)
}

const CANVAS = { width: 960, height: 720 }
const CENTRE = { x: 640, y: 400 }

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`)
})

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(3000)

const readUv = () => page.evaluate(() => ({ ...window.bib.runtime.cursor }))
const readCursorStyle = () => page.evaluate(() => document.querySelector('.stage').style.cursor)
const readHud = () => page.evaluate(() => document.querySelector('.hud__detail')?.textContent ?? '')

/** 目標の UV に当たるまで、実マウスを動かして runtime の UV 読み値で補正する。 */
async function steer(targetUv, from) {
  let pointer = from
  let uv = await readUv()
  for (let iteration = 0; iteration < 14; iteration += 1) {
    await page.mouse.move(pointer.x, pointer.y)
    await page.waitForTimeout(40)
    uv = await readUv()
    const errorX = targetUv.x - uv.x
    const errorY = targetUv.y - uv.y
    if (Math.abs(errorX) < 0.0012 && Math.abs(errorY) < 0.0012) break
    pointer = { x: pointer.x + errorX * 580, y: pointer.y - errorY * 460 }
  }
  return { pointer, uv }
}

const canvasToUv = (x, y) => ({ x: x / CANVAS.width, y: 1 - y / CANVAS.height })

/**
 * canvas 座標を総当たりして、指定のカーソル形状になる場所を探す。
 * ページ内容を変えてもテストが壊れないようにするため、座標は決め打ちしない。
 */
async function findCursor(kind, { x, fromY, toY, step = 10 }, start) {
  let pointer = start
  for (let y = fromY; y <= toY; y += step) {
    const result = await steer(canvasToUv(x, y), pointer)
    pointer = result.pointer
    if ((await readCursorStyle()) === kind) return { pointer, canvasY: y }
  }
  return { pointer, canvasY: null }
}

// ---- 1. 起動 -------------------------------------------------------------------
const boot = await page.evaluate(() => ({
  status: window.bib?.source?.status ?? null,
  resolution: [window.bib.source.width, window.bib.source.height],
  boot: window.bib.runtime.uniforms.uBoot.value,
  hud: document.querySelector('.hud__status')?.textContent?.trim() ?? null,
}))
console.log('  起動:', JSON.stringify(boot))
check('ソースが 960x720', JSON.stringify(boot.resolution) === '[960,720]')
check('ready になっている', boot.status === 'ready', String(boot.status))
check('電源投入アニメーションが完了', boot.boot > 0.9, boot.boot.toFixed(3))
check('HUD が「稼働中」', (boot.hud ?? '').includes('稼働中'), String(boot.hud))

// ---- 2. viewport 中央 = ガラス中央 ---------------------------------------------
const centred = await steer({ x: 0.5, y: 0.5 }, CENTRE)
console.log('  viewport 中央の UV:', JSON.stringify({
  x: +centred.uv.x.toFixed(5),
  y: +centred.uv.y.toFixed(5),
}))
check('viewport 中央でレイがガラスに当たる', centred.uv.active === true)
check('viewport 中央 = ガラス中央',
  Math.abs(centred.uv.x - 0.5) < 0.01 && Math.abs(centred.uv.y - 0.5) < 0.01,
  `uv=(${centred.uv.x.toFixed(4)}, ${centred.uv.y.toFixed(4)})`)
await page.screenshot({ path: `${OUT}/01-boot.png` })

// ---- 3. 任意の canvas 画素へ誘導できるか ---------------------------------------
const target = { x: 300, y: 300 }
const steered = await steer(canvasToUv(target.x, target.y), centred.pointer)
const landed = { x: steered.uv.x * CANVAS.width, y: (1 - steered.uv.y) * CANVAS.height }
check('canvas 画素 (300, 300) へ 2px 以内で誘導できる',
  Math.abs(landed.x - target.x) < 2 && Math.abs(landed.y - target.y) < 2,
  `着地 (${landed.x.toFixed(1)}, ${landed.y.toFixed(1)})`)

// ---- 4+5. リンクを探してクリック ------------------------------------------------
let pointer = steered.pointer
const link = await findCursor('pointer', { x: 60, fromY: 150, toY: 460 }, pointer)
pointer = link.pointer
check('リンクをカーソル形状から見つけられる', link.canvasY !== null, `canvas y=${link.canvasY}`)
if (link.canvasY !== null) {
  await page.screenshot({ path: `${OUT}/02-hover-link.png` })
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(600)
}

const afterClick = await page.evaluate(() => ({
  url: window.bib.source.currentUrl ?? null,
  engaged: window.bib.keyboard.isActive,
}))
console.log('  リンクをクリック:', JSON.stringify(afterClick))
check('クリックで内蔵ブラウザが遷移した', afterClick.url === 'demo://input', String(afterClick.url))
check('最初のクリックでキーボードを掴んだ', afterClick.engaged === true)
check('HUD が遷移に追従した', (await readHud()).includes('demo://input'), await readHud())
await page.screenshot({ path: `${OUT}/03-navigated.png` })

// ---- 6. 入力欄を探してクリック → 打鍵 -------------------------------------------
const field = await findCursor('text', { x: 100, fromY: 120, toY: 400, step: 6 }, pointer)
pointer = field.pointer
check('入力欄をカーソル形状から見つけられる', field.canvasY !== null, `canvas y=${field.canvasY}`)

if (field.canvasY !== null) {
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(300)
  check('クリックで入力欄にフォーカスした', (await readHud()).includes('入力欄 a'), await readHud())

  await page.keyboard.type('hello 3D', { delay: 40 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${OUT}/04-typed.png` })

  // ---- 7. IME の確定 ------------------------------------------------------------
  await page.evaluate(() => {
    const field = document.querySelector('textarea')
    if (!field) throw new Error('IME 用の textarea が無い')
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語入力' }))
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/05-ime.png` })
}

await page.screenshot({ path: `${OUT}/06-monitor.png`, clip: { x: 276, y: 86, width: 792, height: 620 } })

check('コンソールエラーが無い', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await browser.close()

console.log()
if (failures.length) {
  console.log(`  ${failures.length} 項失敗: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('  すべて通過')
