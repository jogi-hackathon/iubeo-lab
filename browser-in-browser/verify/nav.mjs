// クリック遷移の切り分け — ローカル制御ページで各種ナビゲーションを検証。
//
//   npm run dev + wisp + :8088 (python http.server -d public) 起動後:
//   node verify/nav.mjs
//
// nav-a.html 上の各要素をクリックし、location.href / title の変化を観測:
//   same   = <a href> 通常リンク（同一タブ遷移）
//   blank  = target=_blank（新規コンテキスト — 単一ブラウザでは不可のはず）
//   href   = JS location.href 代入
//   push   = history.pushState（SPA 遷移 — ドキュメント再読みなし）
//   form   = form submit
//   redir  = 404 への遷移（wisp 経路のエラーページ挙動）
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8088'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (/xul_render|xul_load|error|fail|NAV|Pthread/i.test(t)) console.log(`  ${t.slice(0, 200)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
await page.goto(`${BASE}/?engine=${ENGINE}&wisp=${encodeURIComponent(WISP)}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log(`  status=${await page.evaluate(() => window.bib?.source?.status)}`)

const evalIn = (js) =>
  page.evaluate(async (src) => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    return Promise.race([
      eng.run({ op: 5, url: src }),
      new Promise((res) => setTimeout(() => res('TIMEOUT'), 8000)),
    ])
  }, js)

console.log(`  load: ${ORIGIN}/nav-a.html`)
await page.evaluate((u) => window.bib.source.navigate(u), `${ORIGIN}/nav-a.html`)
await page.waitForTimeout(4000)
console.log(`  state: ${await evalIn('JSON.stringify({t:document.title,href:location.href})')}`)

// 各ターゲットの座標を取って順にクリック
const targets = await evalIn(`JSON.stringify(
  ['same','blank','href','push','formbtn','wopen','redir'].map((id) => {
    const el = document.getElementById(id)
    if (!el) return { id }
    const r = el.getBoundingClientRect()
    return { id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }))`)
console.log(`  targets: ${targets}`)

const click = async (x, y) => {
  await page.evaluate(([x, y]) => {
    const c = document.getElementById('screen')
    const r = c.getBoundingClientRect()
    const ev = (type) =>
      new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.left + x, clientY: r.top + y,
        screenX: r.left + x, screenY: r.top + y,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
      })
    c.dispatchEvent(ev('mousemove'))
    c.dispatchEvent(ev('mousedown'))
    c.dispatchEvent(ev('mouseup'))
  }, [x, y])
}

let list = []
try { list = JSON.parse(targets) } catch {}

for (const t of list) {
  if (t.x === undefined) continue
  // 各テスト前に nav-a に戻る（最初以外）
  const cur = await evalIn(`JSON.stringify({href:location.href,t:document.title,last:document.body?.dataset.lastclick||''})`)
  await click(t.x, t.y)
  await page.waitForTimeout(3500)
  const after = await evalIn(`JSON.stringify({href:location.href,t:document.title,last:document.body?.dataset.lastclick||''})`)
  console.log(`  [${t.id}] ${cur} -> ${after}`)
  if (!after.includes('nav-a.html') && t.id !== 'redir') {
    await page.evaluate((u) => window.bib.source.navigate(u), `${ORIGIN}/nav-a.html`)
    await page.waitForTimeout(3000)
  }
}
await page.screenshot({ path: `${OUT}/nav.png` })
await browser.close()
