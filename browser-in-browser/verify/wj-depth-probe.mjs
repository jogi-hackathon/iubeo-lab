// engine.mod._wj_set_depth_limit の到達可否と、設定→委譲動作を直接確認
import { chromium } from 'playwright-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const params = new URLSearchParams({ wisp: WISP, engine: 'v0.0.9-inloop' })
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
page.on('console', (m) => { const t = m.text(); if (/gecko|wj|depth/i.test(t)) console.log(' ', t.slice(0, 160)) })
await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.click('.hud__source >> nth=1')
const boot = Date.now()
while (Date.now() - boot < 240_000) {
  const st = await page.evaluate(() => window.bib?.source?.status ?? '?')
  if (st === 'ready' || st === 'error') break
  await page.waitForTimeout(1000)
}
console.log('status:', await page.evaluate(() => window.bib?.source?.status))

const info = await page.evaluate(() => {
  const e = window.bib?.source?.engine
  if (!e) return 'no engine'
  const keys = e.mod ? Object.keys(e.mod).filter((k) => /wj|depth|interp/i.test(k)) : 'no mod'
  return JSON.stringify({
    hasMod: !!e.mod,
    fnType: typeof e.mod?._wj_set_depth_limit,
    wjKeys: keys,
  })
})
console.log('engine api:', info)

// limit=1 を投げて from-content で再帰 → PBL delegate が効くか
const r1 = await page.evaluate(async () => {
  const e = window.bib?.source?.engine
  try { e.mod._wj_set_depth_limit(1) } catch (err) { return 'set failed: ' + err.message }
  const r = await Promise.race([
    e.run({ op: 5, url: `(function(){function f(n){return n<=0?0:f(n-1)+1} for(let i=0;i<3000;i++)f(50); return f(20000)})()` }),
    new Promise((r) => setTimeout(() => r('T/O'), 30000)),
  ])
  return 'after set1: ' + r
})
console.log('depth1 recursion:', r1)
await browser.close()
