// x.com onboarding の「React がマウントしない」原因の深掘り。
// 直接 /i/jf/onboarding/web に飛び、DOM 構造・エラー・初期化状態を観測。
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const ENGINE = process.env.ENGINE ?? 'v0.0.6'
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP, engine: ENGINE })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
if (!process.env.NO_DEPTHCAP) params.set('env.GECKO_WJ_DEPTHLIMIT', process.env.DEPTHCAP ?? '350000')
if (process.env.PBL) params.set('env.GECKO_NOWASMJIT', '1')
if (process.env.VALVE) params.set('env.GECKO_WJ_NODEPTHTHROW', '1')

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[gecko]')) console.log(`  ${t.slice(0, 220)}`)
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
      new Promise((res) => setTimeout(() => res('EVAL_TIMEOUT'), 12_000)),
    ])
  }, js)

// エラーフックを仕込んでから遷移（最初の遷移は direct navigate = 新規ドキュメント →
// フックは消える。なので最初に window.open 差し替え型フックは使えず、
// 「遷移後に即 hook」+「発生済みエラーは console ログで拾う」二段構え）
console.log('  onboarding へ直接遷移…')
await page.evaluate(() =>
  window.bib.source.navigate('https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2F'))

// readyState=complete になるまで最大 60s
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000)
  const rs = await evalIn('document.readyState')
  if (rs === '"complete"' || rs === 'complete') break
}

// 以降のエラーを捕らえる hook を設置
await evalIn(`(function(){
  window.__errs = window.__errs || [];
  if (!window.__hooked) {
    window.__hooked = true;
    window.addEventListener('error', e => __errs.push('err:' + (e.message||'') + ' @' + (e.filename||'').split('/').pop() + ':' + e.lineno));
    window.addEventListener('unhandledrejection', e => __errs.push('rej:' + String(e.reason).slice(0,120)));
  }
  return 'hooked';
})()`)

// マウント状態を 3 回観測（DOM 構造 + フック済みエラー + リソース内訳）
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(10_000)
  const s = await evalIn(`JSON.stringify({
    rs: document.readyState,
    rootKids: [...document.body.children].map(e => e.tagName + (e.id ? '#' + e.id : '') + '.' + String(e.className).slice(0, 30)).slice(0, 12),
    bodyLen: document.body.innerText.length,
    inputs: document.querySelectorAll('input').length,
    resByType: (() => { const h = {}; for (const r of performance.getEntriesByType('resource')) h[r.initiatorType] = (h[r.initiatorType] || 0) + 1; return h })(),
    scriptSrcs: [...document.scripts].map(s => (s.src || 'inline').split('/').pop().slice(0, 50)),
    errs: (window.__errs || []).slice(0, 15),
    castle: typeof window.castle !== 'undefined' ? 'present' : typeof Castle !== 'undefined' ? 'Castle' : 'none',
    globals: Object.keys(window).filter(k => /castle|react|__APP|__NEXT|webpack|chunk/i.test(k)).slice(0, 15),
  })`)
  console.log(`  [obs ${i}] ${s}`)
}

await page.screenshot({ path: `${OUT}/x-login2.png` })
await browser.close()
