import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const BASE = 'http://localhost:5199'
const SITE_DIR = '/Users/thirdlf03/src/github.com/thirdlf03/firefox-wasm/bench/site/build'

async function evalBig(page, src) {
  await page.evaluate(() => window.bib.source.engine.evalChrome('globalThis.__bibBuf=""'))
  for (let i = 0; i < src.length; ) {
    let end = Math.min(i + 6000, src.length)
    while (end > i + 1 && Buffer.byteLength(JSON.stringify(src.slice(i, end)), 'utf8') > 7500) end--
    if (src.charCodeAt(end - 1) >= 0xd800 && src.charCodeAt(end - 1) <= 0xdbff) end--
    await page.evaluate(
      (c) => window.bib.source.engine.evalChrome(`globalThis.__bibBuf+=${c}`),
      JSON.stringify(src.slice(i, end)),
    )
    i = end
  }
  return page.evaluate(() => window.bib.source.engine.evalChrome('eval(globalThis.__bibBuf)'))
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--js-flags=--max-old-space-size=4096'] })

async function arm(nowasmjit, extra) {
  const page = await browser.newPage()
  const env = (nowasmjit ? 'env.GECKO_NOWASMJIT=1' : '') + (extra || '')
  await page.goto(`${BASE}/?${env}`, { waitUntil: 'load' })
  await page.waitForSelector('#root canvas', { timeout: 20000 })
  await page.waitForTimeout(1500)
  await page.click('.hud__source >> nth=1')
  for (let i = 0; i < 150; i++) {
    const s = await page.evaluate(() => window.bib.source.status)
    if (s === 'ready' || s === 'error' || s === 'unavailable') break
    await page.waitForTimeout(2000)
  }
  const program = `${readFileSync(`${SITE_DIR}/data-home.js`, 'utf8')}\n${readFileSync(`${SITE_DIR}/dom.js`, 'utf8')}\n;(function(){
    var b=new Benchmark(); b.setup();
    var per=[];
    for(var i=0;i<6;i++){ b.runIteration(); per.push(b.result()); }
    return JSON.stringify(per);})()`
  const out = await evalBig(page, program)
  console.log(`${nowasmjit ? 'PBL' : 'JIT'}${extra || ''}: ${String(out).slice(0, 200)}`)
  await page.close()
}

await arm(false, '')
await arm(false, '')
await arm(true, '')
await browser.close()
