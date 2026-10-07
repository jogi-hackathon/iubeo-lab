// _blank 修正をエンジン再ビルドなしで検証 — OPFS のプロファイルに user.js を
// 書き込んでから起動し、target=_blank / window.open が同一ウィンドウ遷移に
// なるか確かめる。
//
//   node verify/nav-userjs.mjs
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8088'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (/xul_|gecko|error|fail|Pthread/i.test(t)) console.log(`  ${t.slice(0, 200)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

await page.goto(`${BASE}/?engine=${ENGINE}&wisp=${encodeURIComponent(WISP)}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })

// ---- OPFS に user.js を書き込む（エンジン起動前） -------------------------
const w = await page.evaluate(async () => {
  try {
    const root = await navigator.storage.getDirectory()
    const prof = await root.getDirectoryHandle('gecko-profile', { create: true })
    const fh = await prof.getFileHandle('user.js', { create: true })
    const ws = await fh.createWritable()
    await ws.write(
      'user_pref("browser.link.open_newwindow", 1);\n' +
      'user_pref("browser.link.open_newwindow.restriction", 0);\n')
    await ws.close()
    return 'written: ' + (await fh.getFile()).size + ' bytes'
  } catch (e) {
    return 'OPFS write failed: ' + e.message
  }
})
console.log(`  user.js: ${w}`)

// ---- エンジン起動 ----------------------------------------------------------
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
      new Promise((res) => setTimeout(() => res('TIMEOUT'), 10_000)),
    ])
  }, js)

// user.js が読まれたか — 読めたかどうかを pref 値で直接は見れない（ページ権限）ので
// 挙動で確かめる。まず nav-a を読んで _blank / window.open をクリック。
await page.evaluate((u) => window.bib.source.navigate(u), `${ORIGIN}/nav-a.html`)
await page.waitForTimeout(4000)
console.log(`  state: ${await evalIn('JSON.stringify({t:document.title,href:location.href})')}`)

const targets = await evalIn(`JSON.stringify(
  ['blank','wopen'].map((id) => {
    const el = document.getElementById(id)
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

for (const t of JSON.parse(targets)) {
  const cur = await evalIn(`JSON.stringify({href:location.href,t:document.title,last:document.body?.dataset.lastclick||''})`)
  await click(t.x, t.y)
  await page.waitForTimeout(3500)
  const after = await evalIn(`JSON.stringify({href:location.href,t:document.title,last:document.body?.dataset.lastclick||''})`)
  console.log(`  [${t.id}] ${cur} -> ${after}`)
  if (!after.includes('nav-a.html')) {
    await page.evaluate((u) => window.bib.source.navigate(u), `${ORIGIN}/nav-a.html`)
    await page.waitForTimeout(3000)
  }
}
await browser.close()
