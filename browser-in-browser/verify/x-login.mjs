// x.com ログイン onboarding がスピナーで止まる原因の切り分け。
// 手順: x.com 読み込み → 「Continue with phone」相当のリンクをクリック →
// 遷移先の DOM/リソース/保留中の通信を観測する。
//
//   node verify/x-login.mjs
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHCAP ?? '350000')

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]') && /error|fail|denied|abort|timeout|block|unhandled/i.test(t))
    console.log(`  ${t.slice(0, 220)}`)
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}

const evalIn = (js) =>
  page.evaluate(async (src) => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    return Promise.race([
      eng.run({ op: 5, url: src }),
      new Promise((res) => setTimeout(() => res('EVAL_TIMEOUT'), 10_000)),
    ])
  }, js)

console.log('  x.com を読み込み…')
await page.evaluate(() => window.bib.source.navigate('https://x.com'))
await page.waitForTimeout(12_000)
console.log(`  landing: ${await evalIn('JSON.stringify({t:document.title,rs:document.readyState})')}`)

// onboarding へのリンクをクリック（遷移系クリックが有効なことを再利用）
const target = await evalIn(`JSON.stringify((() => {
  const a = document.querySelector('a[href*="/i/jf/onboarding"], a[href*="/login"]')
  if (!a) return null
  const r = a.getBoundingClientRect()
  return { href: a.getAttribute('href'), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }
})())`)
console.log(`  login link: ${target}`)
const t0 = JSON.parse(target)
if (t0) {
  await page.evaluate(([x, y]) => {
    const c = document.getElementById('screen')
    const r = c.getBoundingClientRect()
    const ev = (type) => new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + x, clientY: r.top + y,
      screenX: r.left + x, screenY: r.top + y,
      button: 0, buttons: type === 'mouseup' ? 0 : 1,
    })
    c.dispatchEvent(ev('mousemove')); c.dispatchEvent(ev('mousedown')); c.dispatchEvent(ev('mouseup'))
  }, [t0.x, t0.y])
}

// 遷移先を待ちつつ、SPA が何を待っているか観測
await page.waitForTimeout(6000)
for (let i = 0; i < 6; i++) {
  const s = await evalIn(`JSON.stringify({
    href: location.href.slice(0, 80),
    rs: document.readyState,
    bodyLen: document.body ? document.body.innerText.length : -1,
    domLen: document.documentElement ? document.documentElement.outerHTML.length : -1,
    inputs: document.querySelectorAll('input').length,
    buttons: document.querySelectorAll('button,[role=button]').length,
    scripts: document.scripts.length,
    res: performance.getEntriesByType('resource').length,
    resPending: performance.getEntriesByType('resource').filter(r => !r.responseEnd).length,
    lastRes: (performance.getEntriesByType('resource').slice(-4).map(r =>
      r.name.split('/').pop().slice(0, 40) + ':' + Math.round(r.duration) + 'ms' + (r.responseEnd ? '' : '*PENDING*'))),
    iframes: document.querySelectorAll('iframe').length,
    spinner: !!document.querySelector('[role=progressbar], .spinner, [data-testid*=spinner]'),
    txt: document.body ? document.body.innerText.slice(0, 120) : '',
  })`)
  console.log(`  [t+${i * 8 + 6}s] ${s}`)
  if (i < 5) await page.waitForTimeout(8000)
}

// JS エラーの有無: window.onerror フックは後付けなので、既知の失敗を直接確認
const diag = await evalIn(`JSON.stringify({
  nav: navigator.userAgent.slice(0, 60),
  webgl: (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')) } catch (e) { return 'threw:' + e.message } })(),
  webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2') } catch (e) { return 'threw' } })(),
  sw: 'serviceWorker' in navigator,
  idb: typeof indexedDB !== 'undefined',
  crypto: typeof crypto !== 'undefined' && !!crypto.subtle,
  wasm: typeof WebAssembly !== 'undefined',
  workers: typeof Worker !== 'undefined',
})`)
console.log(`  diag: ${diag}`)

await page.screenshot({ path: `${OUT}/x-login.png` })
await browser.close()
