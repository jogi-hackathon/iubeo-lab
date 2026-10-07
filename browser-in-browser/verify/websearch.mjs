// Web Search タスクの端から端の検証。
//
//   npm run dev（:5173）+ npm run wisp（:5001）を起動しておき、
//   node verify/websearch.mjs
//
// 確認すること:
//   1. Gecko エンジンが起動すると Google の検索画面が最初に開く（websearch モード）
//   2. HUD のタスクパネルにお題と「このページを提出」が出る
//   3. 実サイトへ遷移し、提出すると /api/judge（jev）のスコアがパネルに出る
//
// 結果は verify/shots/ に保存する。
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE =
  process.env.BASE_URL ??
  'http://localhost:5173/?wisp=ws://127.0.0.1:5001/&task=WebAssembly'
const TASK = process.env.TASK_WORD ?? 'WebAssembly'
// お題に対する「適切な提出」の実演用。軽くて確実に開ける静的サイトを選ぶ。
const ANSWER = process.env.ANSWER_URL ?? 'https://webassembly.org/'
const OUT = 'verify/shots'
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
    '--js-flags=--max-old-space-size=4096',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
const geckoLog = []
page.on('console', (m) => {
  const text = m.text()
  // [wasm-host] compile failed はエンジンの JS→WASM JIT が一部の関数を
  // lowering できないときの既知のノイズ（フォールバックして実行は続く）。
  // この機能の検証対象ではないので除外する。
  if (m.type() === 'error' && !text.includes('[wasm-host] compile failed')) {
    errors.push(text)
  }
  if (text.startsWith('[gecko]')) geckoLog.push(text.replace('[gecko] ', ''))
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(1000)

// ---- 0. HUD のパネルが出ているか（デモソースでは出ないので Gecko を選ぶ） ------
await page.locator('.hud__source', { hasText: 'Gecko' }).click()
await page.waitForSelector('.task', { timeout: 10_000 })
check('タスクパネルが HUD に出る', true)

const taskWord = await page.locator('.task__word').textContent()
check('お題が ?task= の値になっている', taskWord?.trim() === TASK, taskWord)

// ---- 1. 起動すると最初に Google が開いている ----------------------------------
const t0 = Date.now()
let status = ''
for (;;) {
  status = await page.evaluate(() => window.bib.source.status)
  if (['ready', 'error', 'unavailable'].includes(status)) break
  if (Date.now() - t0 > 300_000) break
  await page.waitForTimeout(1000)
}
console.log(`boot: ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
check('エンジンが ready', status === 'ready', status)

// エンジン内の現在位置を eval で直接読む（HUD のポーリングより確実）。
const readLocation = () =>
  page.evaluate(async () => {
    const eng = window.bib.source?.engine
    if (!eng?.run) return null
    return eng.run({ op: 5, url: 'location.href' })
  })

const firstUrl = (await readLocation()) ?? ''
console.log(`  最初のページ: ${firstUrl}`)
check('起動直後に Google が開いている', /google\.(com|co\.|com\.)/.test(firstUrl), firstUrl)

await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/30-websearch-google.png` })

// ---- 2. 実サイトへ遷移して提出 -------------------------------------------------
if (status === 'ready') {
  await page.evaluate((url) => window.bib.source.navigate(url), ANSWER)
  const navDeadline = Date.now() + 120_000
  let landed = ''
  for (;;) {
    landed = (await readLocation()) ?? ''
    if (landed.includes('webassembly.org')) break
    if (Date.now() > navDeadline) break
    await page.waitForTimeout(1000)
  }
  check('解答サイトへ遷移できた', landed.includes('webassembly.org'), landed)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${OUT}/31-websearch-answer.png` })

  // 提出ボタンを押す。ボタンが有効になるのは「現在のページ」のポーリングが
  // http(s) を拾ってから。
  const submit = page.locator('.task__submit')
  await submit.waitFor({ state: 'visible', timeout: 15_000 })
  const enabledDeadline = Date.now() + 15_000
  while ((await submit.isDisabled()) && Date.now() < enabledDeadline) {
    await page.waitForTimeout(500)
  }
  check('提出ボタンが有効', !(await submit.isDisabled()))
  await submit.click()

  // jev の応答を待つ（ネットワーク + LLM なので余裕を持つ）。
  await page.waitForSelector('.task__verdict', { timeout: 120_000 })
  const verdictText = await page.locator('.task__verdict').textContent()
  console.log(`  判定: ${verdictText?.trim()}`)
  check('jev の判定が表示された', !/見つかりません|失敗|届きません/.test(verdictText ?? ''), verdictText?.trim())
  await page.screenshot({ path: `${OUT}/32-websearch-verdict.png` })
}

check('致命的なエラーが無い', errors.length === 0, errors.slice(0, 4).join(' | '))

await browser.close()

console.log()
if (failures.length) {
  console.log(`  ${failures.length} 項失敗: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('  すべて通過')
