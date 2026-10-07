// YouTube 実地テスト。watch ページを wisp 経由でエンジンに読ませ、
// video 要素が生成されて再生が始まるかを観測する。
//
//   npm run dev + npm run wisp + 動画用 IPv4 サーバ (8088) を起動しておいてから:
//   node verify/youtube.mjs
//
// 観測:
//   - video 要素の存在・readyState・currentTime の進行
//   - MSE/SourceBuffer の使われ方（adaptive ストリーミング経路）
//   - host VideoDecoder 作成数/コーデック（vp9/av1/h264 のどれが選ばれたか）

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
// 既定は軽めの公式テスト動画（Big Buck Bunny トレイラー）
const WATCH = process.env.WATCH ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const WATCH_MS = Number(process.env.WATCH_MS ?? 45_000)
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP })
params.set('env.GECKO_CONTENT_CONSOLE', '1')
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
    if (/VIDEO|webcodecs|error|Error|fail/i.test(t)) console.log(`  ${t}`)
  }
})
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`))

// host 側のデコーダ生成を数える（どのコーデックが選ばれたか分かる）
await page.addInitScript(() => {
  const stats = { video: [], audio: [], frames: 0, errors: [] }
  window.__wcStats = stats
  if (typeof VideoDecoder !== 'undefined') {
    const RealVD = VideoDecoder
    window.VideoDecoder = class extends RealVD {
      constructor(init) {
        super({
          output: (f) => {
            stats.frames++
            init.output(f)
          },
          error: (e) => {
            stats.errors.push(String(e))
            init.error(e)
          },
        })
      }
      configure(cfg) {
        stats.video.push(cfg.codec)
        return super.configure(cfg)
      }
      static isConfigSupported(c) {
        return RealVD.isConfigSupported(c)
      }
    }
  }
  if (typeof AudioDecoder !== 'undefined') {
    const RealAD = AudioDecoder
    window.AudioDecoder = class extends RealAD {
      configure(cfg) {
        stats.audio.push(cfg.codec)
        return super.configure(cfg)
      }
      static isConfigSupported(c) {
        return RealAD.isConfigSupported(c)
      }
    }
  }
})

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
console.log(`  engine status: ${status}`)
if (status !== 'ready') {
  await browser.close()
  process.exit(1)
}

console.log(`  navigating: ${WATCH}`)
await page.evaluate((u) => window.bib.source.navigate(u), WATCH)

// YouTube は重いのでロード+再生開始を長めに待ちながら video 要素の状態を追う
const probe = async () =>
  page.evaluate(async () => {
    const eng = window.bib?.source?.engine
    if (!eng?.run) return 'no engine'
    const js = `(function(){
      const v = document.querySelector('video');
      if (!v) return 'novideo';
      return 't='+v.currentTime.toFixed(2)+' rs='+v.readyState+
        ' paused='+v.paused+' vw='+v.videoWidth+'x'+v.videoHeight+
        ' src='+(v.currentSrc||'').slice(0,80)+
        ' buf='+(v.buffered.length?v.buffered.end(v.buffered.length-1).toFixed(1):'none')+
        ' net='+v.networkState+' err='+(v.error&&v.error.code);
    })()`
    try {
      const r = await eng.run({ op: 5, url: js })
      return typeof r === 'string' ? r : String(r)
    } catch (e) {
      return `evalerr:${e.message}`
    }
  })

const t0 = Date.now()
let last = ''
while (Date.now() - t0 < WATCH_MS) {
  const s = await probe()
  if (s !== last) {
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
    last = s
  }
  await page.waitForTimeout(3000)
}

await page.screenshot({ path: `${OUT}/youtube.png` })
const wc = await page.evaluate(() => window.__wcStats)
console.log(`  host decoders: ${JSON.stringify(wc)}`)
await browser.close()
