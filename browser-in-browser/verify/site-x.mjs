// x.com 実地テスト + クリック遷移の検証。
//
//   npm run dev + npm run wisp を起動しておいてから:
//   node verify/site-x.mjs
//
// 観測:
//   - ナビゲーションの所要時間（load イベント、DOM の見え方）
//   - ページ内クリック → SPA 遷移が効くか（ログインボタン等）
//   - target=_blank / window.open 系が届かない既知の穴を切り分ける

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const URL_TARGET = process.env.SITE ?? 'https://x.com'
const WAIT_MS = Number(process.env.WAIT_MS ?? 120_000)
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
// 再帰ガード: 既定値 2.5MB は実際のホスト wasm スタック（~1MB）より大きく、
// 深い再帰で pthread ごと死ぬ。閾値を絞って catchable InternalError に収める
// （v0.0.8+ のキャリブレーションと同趣旨を既存ビルドで再現）。
if (!process.env.NO_DEPTHCAP) params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHCAP ?? '350000')
if (process.env.GPU) {
  params.set('env.GECKO_GPU', '1')
  params.set('env.GECKO_GL_PASSTHROUGH', '1')
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--js-flags=--max-old-space-size=4096'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const geckoLog = []
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]') || t.startsWith('[webcodecs]')) {
    geckoLog.push(t)
    if (/xul_render|load stop|NAV|error|fail/i.test(t)) console.log(`  ${t.slice(0, 220)}`)
  }
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(1500)

await page.click('.hud__source >> nth=1')
const bootStarted = Date.now()
let status = 'booting'
while (Date.now() - bootStarted < 240_000) {
  status = await page.evaluate(() => window.bib.source.status)
  if (status !== 'booting' && status !== 'idle') break
  await page.waitForTimeout(1000)
}
console.log(`  engine status: ${status}（${Math.round((Date.now() - bootStarted) / 1000)}s）`)
if (status !== 'ready') {
  await browser.close()
  process.exit(1)
}

// コンテンツコンテキストで式を評価（op=5 = RunChromeScript; content global が返る）
const evalIn = (js) =>
  page.evaluate(async (src) => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    try {
      return await eng.run({ op: 5, url: src })
    } catch (e) {
      return `evalerr:${e.message}`
    }
  }, js)

const navStart = Date.now()
console.log(`  navigating: ${URL_TARGET}`)
await page.evaluate((u) => window.bib.source.navigate(u), URL_TARGET)

// ロード経過をポーリング: readyState / title / 本文の文字数
let lastSig = ''
const t0 = Date.now()
while (Date.now() - t0 < WAIT_MS) {
  const s = await evalIn(`JSON.stringify({
    t: document.title, rs: document.readyState,
    loc: location.href.slice(0,90),
    body: document.body ? document.body.innerText.length : -1,
    links: document.querySelectorAll('a').length,
    btns: document.querySelectorAll('button,[role=button]').length,
  })`)
  if (s !== lastSig) {
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
    lastSig = s
  }
  if (typeof s === 'string' && s.includes('"rs":"complete"') && s.includes('"body":')) {
    try {
      const o = JSON.parse(s)
      if (o.body > 500 && o.links > 5) break
    } catch {}
  }
  await page.waitForTimeout(4000)
}

await page.screenshot({ path: `${OUT}/site-x.png` })

// ---- クリック遷移テスト -------------------------------------------------------
// ページ内の <a> / [role=link] を拾い、座標を出して DOM イベントとして canvas に打つ。
// クリック後に location.href / DOM が変わるかで「遷移系クリック」の到達を見る。

const anchors = await evalIn(`JSON.stringify(
  [...document.querySelectorAll('a[href],[role=link],[data-testid*=login],[data-testid*=Login],[role=button]')].slice(0, 40).map((a) => {
    const r = a.getBoundingClientRect()
    return {
      href: a.getAttribute('href') || '',
      text: (a.innerText || a.getAttribute('aria-label') || a.getAttribute('data-testid') || '').slice(0, 40),
      target: a.getAttribute('target') || '',
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      vis: r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 720,
    }
  }).filter((a) => a.vis)
)`)
console.log(`  visible anchors: ${anchors}`)

let list = []
try { list = JSON.parse(anchors) } catch {}
// ログイン系を最優先 → SPA 内遷移 → その他（_blank は別経路）
const isLogin = (a) => /log\s*in|sign\s*in|login/i.test(`${a.text} ${a.href}`)
const pick =
  list.find((a) => isLogin(a) && !a.target) ||
  list.find((a) => a.href.startsWith('/') && !a.target) ||
  list.find((a) => !a.target && a.href && !a.href.startsWith('javascript'))
console.log(`  login 系リンク: ${JSON.stringify(list.filter(isLogin))}`)

if (pick) {
  const before = await evalIn(`location.href`)
  console.log(`  click 対象: "${pick.text}" href=${pick.href} @(${pick.x},${pick.y})`)
  console.log(`  before: ${before}`)
  const clickT0 = Date.now()

  await page.evaluate(([x, y]) => {
    const c = document.getElementById('screen')
    const r = c.getBoundingClientRect()
    const opts = (type) =>
      new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.left + x, clientY: r.top + y,
        screenX: r.left + x, screenY: r.top + y,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
      })
    c.dispatchEvent(opts('mousemove'))
    c.dispatchEvent(opts('mousedown'))
    c.dispatchEvent(opts('mouseup'))
  }, [pick.x, pick.y])

  // SPA pushState / 遷移の反映を時間分解で見る（+1s, +4s, +8s, +15s）
  for (const wait of [1000, 3000, 4000, 7000]) {
    await page.waitForTimeout(wait)
    const el = ((Date.now() - clickT0) / 1000).toFixed(1)
    const st = await evalIn(`JSON.stringify({href:location.href.slice(0,90), title:document.title, rs:document.readyState, body:document.body?document.body.innerText.length:-1})`)
    console.log(`  [click+${el}s] ${st}`)
  }

  // _blank / window.open 系も試す（新規タブが開けない構造で何が起きるか）
  const blank = list.find((a) => a.target === '_blank')
  if (blank) {
    console.log(`  _blank リンク試行: "${blank.text}" ${blank.href}`)
    await page.evaluate(([x, y]) => {
      const c = document.getElementById('screen')
      const r = c.getBoundingClientRect()
      const opts = (type) =>
        new MouseEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: r.left + x, clientY: r.top + y, button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
        })
      c.dispatchEvent(opts('mousedown'))
      c.dispatchEvent(opts('mouseup'))
    }, [blank.x, blank.y])
    await page.waitForTimeout(6000)
    const after2 = await evalIn(`JSON.stringify({href:location.href, title:document.title})`)
    console.log(`  _blank 後: ${after2}`)
  }
} else {
  console.log('  クリック可能なアンカーが見つからなかった')
}

await page.screenshot({ path: `${OUT}/site-x-after-click.png` })
console.log('\n  最近のエンジンログ:')
for (const l of geckoLog.slice(-12)) console.log(`    ${l.slice(0, 200)}`)
await browser.close()
