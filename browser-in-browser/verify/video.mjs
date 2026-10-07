// wasm エンジンの動画再生テスト。ローカルのテスト動画（フレーム番号焼き込み済み）を
// エンジンに読ませ、提示されたフレームのユニーク数から実効 fps を測る。
//
//   npm run dev + npm run wisp を起動しておいてから:
//   node verify/video.mjs                       # software 合成・VP9
//   GPU=1 node verify/video.mjs                 # GECKO_GPU=1（WebRender 合成）
//   VIDEO=/v720p30-h264.mp4 node verify/video.mjs
//   ENGINE=v0.0.1 node verify/video.mjs         # エンジンの版を変える
//
// 観測するもの:
//   - 提示 fps（フレーム番号領域のユニーク画像数 / 経過時間）
//   - [webcodecs] ブリッジの警告（format / ring overflow = コピー経路のどこが詰まるか）

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const WISP = process.env.WISP ?? 'ws://127.0.0.1:5001/'
const VIDEO = process.env.VIDEO ?? 'v720p30-vp9.webm'
const GPU = !!process.env.GPU
const ENGINE = process.env.ENGINE ?? ''
const WATCH_MS = Number(process.env.WATCH_MS ?? 15_000)
const SAMPLE_EVERY_MS = Number(process.env.SAMPLE_EVERY_MS ?? 60)
const OUT = 'verify/shots'
mkdirSync(OUT, { recursive: true })

const params = new URLSearchParams({ wisp: WISP })
// ページ内 console.log をエンジン stdout（[gecko] ログ）へ流す。
params.set('env.GECKO_CONTENT_CONSOLE', '1')
if (GPU) {
  params.set('env.GECKO_GPU', '1')
  params.set('env.GECKO_GL_PASSTHROUGH', '1')
}
if (ENGINE) params.set('engine', ENGINE)

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    // SWGL=1 のときだけソフトウェア GL。既定はホストの実 GPU（three.js が CPU
    // ラスタライズを占有して計測全体が歪むのを避けるため）。
    ...(process.env.SWGL
      ? ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
      : []),
    '--js-flags=--max-old-space-size=4096',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const geckoLog = []
page.on('console', (message) => {
  const text = message.text()
  if (text.startsWith('[gecko]') || text.startsWith('[webcodecs]')) {
    geckoLog.push(text)
    console.log(`  ${text}`)
  }
})
page.on('pageerror', (error) => console.log(`  pageerror: ${error.message}`))

// エンジンより先に仕込む: host VideoDecoder/AudioDecoder の生の呼び出しを数える。
// ブリッジ（gecko.js 内）が実際に host デコーダへ届いているかを外部から観測する。
await page.addInitScript(() => {
  const stats = { created: 0, configured: [], decodes: 0, frames: 0, lastFormat: '', errors: [], queue: [], outputMs: 0, copyToMs: 0 }
  window.__wcStats = stats
  if (typeof VideoDecoder !== 'undefined') {
    const RealVD = VideoDecoder
    window.VideoDecoder = class extends RealVD {
      constructor(init) {
        const wrapped = {
          output: (f) => {
            stats.frames++
            stats.lastFormat = f.format
            // copyTo（GPU readback + 変換の非同期部分）の実時間を測る
            const origCopyTo = f.copyTo.bind(f)
            f.copyTo = (dest, opts) => {
              const t = performance.now()
              const r = origCopyTo(dest, opts)
              Promise.resolve(r).then((x) => {
                stats.copyToMs += performance.now() - t
                stats.copyToMax = Math.max(stats.copyToMax || 0, performance.now() - t)
                return x
              })
              return r
            }
            const t = performance.now()
            init.output(f)
            stats.outputMs += performance.now() - t
          },
          error: (e) => {
            stats.errors.push(String(e))
            init.error(e)
          },
        }
        super(wrapped)
        stats.created++
        stats.lastDecoder = this
        stats.queueTimer = setInterval(() => stats.queue.push(this.decodeQueueSize), 500)
      }
      configure(cfg) {
        stats.configured.push(`${cfg.codec} ${cfg.codedWidth}x${cfg.codedHeight}`)
        return super.configure(cfg)
      }
      decode(chunk) {
        stats.decodes++
        return super.decode(chunk)
      }
      static isConfigSupported(cfg) {
        return RealVD.isConfigSupported(cfg)
      }
      close() {
        if (stats.queueTimer) clearInterval(stats.queueTimer)
        return super.close()
      }
    }
  }

  // ペイント経路の観測: blit が putImageData を何回/どの速さで呼ぶか + rAF の回数。
  const paint = { puts: 0, putMs: 0, rafs: 0 }
  window.__paintStats = paint
  const realPut = CanvasRenderingContext2D.prototype.putImageData
  CanvasRenderingContext2D.prototype.putImageData = function (...a) {
    const t = performance.now()
    const r = realPut.apply(this, a)
    paint.puts++
    paint.putMs += performance.now() - t
    return r
  }
  const realRaf = window.requestAnimationFrame
  window.requestAnimationFrame = (cb) => {
    paint.rafs++
    return realRaf(cb)
  }
})

await page.goto(`${BASE}/?${params}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(1500)

// エンジン起動後に runCmd を包んで、op 別の実処理時間（キュー待ちを除く）を記録する。
// pump→runCmd の await がエンジン側の実コスト。キュー深さも同時に記録する。
const instrumentCmd = async () =>
  page.evaluate(() => {
    const eng = window.bib?.source?.engine
    if (!eng || eng.__cmdWrapped) return 'no'
    const P = Object.getPrototypeOf(eng)
    const orig = P.runCmd
    const rec = (window.__cmdStats = { times: {}, qDepth: [] })
    P.runCmd = async function (item) {
      rec.qDepth.push(this.queue.length)
      const t = performance.now()
      try {
        return await orig.call(this, item)
      } finally {
        const k = `op${item.op}`
        ;(rec.times[k] ||= []).push(Math.round(performance.now() - t))
      }
    }
    eng.__cmdWrapped = true
    return 'ok'
  })

// Gecko ソースへ切り替えて起動を待つ
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
console.log(`  runCmd 計装: ${await instrumentCmd()}`)

// 静止ページ（ウェルカム）での OP_PAINT 実処理時間 — 動画再生中と比較して
// 「RenderDocument が遅い」のか「メディア再生のイベント処理がコマンドを待たせる」のか分離。
const idleLat = await page.evaluate(async () => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return null
  const ts = []
  for (let i = 0; i < 6; i++) {
    const t = performance.now()
    await eng.run({ op: 4 })
    ts.push(Math.round(performance.now() - t))
  }
  return ts
})
console.log(`  静止ページ OP_PAINT: ${JSON.stringify(idleLat)} ms`)

// テスト動画を全面表示するだけのページへ遷移（video 要素 → MediaDocument 直読みより確実）
// 動画は IPv4 で listen する別サーバ（`python3 -m http.server 8088 -d public`）から
// wisp 経由で取る。vite は ::1 のみで listen するため 127.0.0.1:5173 には届かない。
const videoUrl = `${process.env.VIDEO_BASE ?? 'http://127.0.0.1:8088'}/${VIDEO}`
const doc =
  'data:text/html;base64,' +
  Buffer.from(
    `<body style="margin:0;background:#000">` +
      `<video id="v" src="${videoUrl}" autoplay muted ` +
      `style="position:fixed;inset:0;width:100vw;height:100vh"></video>` +
      `<script>` +
      `const v=document.getElementById('v');` +
      `for(const ev of['loadstart','loadedmetadata','canplay','playing','error','stalled','waiting','timeupdate'])` +
      `v.addEventListener(ev,()=>console.log('VIDEO_EV',ev,'t='+v.currentTime.toFixed(1),'rs='+v.readyState,` +
      `v.videoWidth+'x'+v.videoHeight,'err='+(v.error&&v.error.code),'net='+v.networkState));` +
      `setInterval(()=>console.log('VIDEO_TICK t='+v.currentTime.toFixed(2),'rs='+v.readyState,'vw='+v.videoWidth,` +
      `'paused='+v.paused,'buf='+(v.buffered.length?v.buffered.end(v.buffered.length-1).toFixed(1):'none')),1000);` +
      `console.log('VIDEO canPlay webm/vp9='+v.canPlayType('video/webm; codecs="vp9"'),` +
      `'mp4/avc1='+v.canPlayType('video/mp4; codecs="avc1.42E01E"'),` +
      `'mse='+typeof MediaSource,` +
      `'vp9mse='+MediaSource.isTypeSupported('video/webm; codecs="vp9"'));` +
      `setTimeout(()=>{` +
      `console.log('VIDEO paused='+v.paused+' calling play()');` +
      `v.play().then(()=>console.log('VIDEO play() OK')).catch(e=>console.log('VIDEO play() FAIL '+e.name+' '+e.message));` +
      `},2000);` +
      `</script></body>`,
  ).toString('base64')
console.log(`  navigating: ${videoUrl}${GPU ? '  [GPU mode]' : ''}`)
await page.evaluate((u) => window.bib.source.navigate(u), doc)
await page.waitForTimeout(4000) // 読み込み+バッファ待ち

// フレーム番号（動画左上の白文字）が映る領域を周期的に読み、ユニーク数を数える。
// 30fps 動画なら distinct≈経過秒×30 が理想。がくつき = distinct が小さい/間隔がバラつく。
const seen = []
const t0 = Date.now()
while (Date.now() - t0 < WATCH_MS) {
  const hash = await page.evaluate(() => {
    const canvas = document.getElementById('screen')
    if (!canvas) return 'nocanvas'
    try {
      let src = canvas
      let w = canvas.width || canvas.clientWidth || 960
      let hgt = canvas.height || canvas.clientHeight || 720
      // GPU モード: #screen は OffscreenCanvas 移譲済みで getContext 不可。
      // ただし placeholder 自体は画像ソースとして生きているので drawImage で読む。
      let ctx2d = null
      try { ctx2d = canvas.getContext('2d') } catch { /* transferred */ }
      if (!ctx2d) {
        const probe = (window.__probe ||= Object.assign(document.createElement('canvas'), { width: w, height: hgt }))
        const pctx = probe.getContext('2d')
        pctx.drawImage(canvas, 0, 0, w, hgt)
        src = probe
      }
      // 全画面を間引きハッシュ（動画はレターボックスされるので一部領域だと取りこぼす）
      const { data } = src.getContext('2d').getImageData(0, 0, w, hgt)
      let h = 0
      for (let i = 0; i < data.length; i += 64) h = (h * 31 + data[i] + data[i + 1] + data[i + 2]) | 0
      return h
    } catch (e) {
      return `err:${e.message}`
    }
  })
  seen.push({ t: Date.now() - t0, hash })
  await page.waitForTimeout(SAMPLE_EVERY_MS)
}

await page.screenshot({ path: `${OUT}/video-${GPU ? 'gpu' : 'sw'}-${VIDEO.replace(/\W+/g, '_')}.png` })

// host 側デコーダの実績（ブリッジがどこまで届いたか）
const wc = await page.evaluate(() => window.__wcStats)
console.log(`  host VideoDecoder: ${JSON.stringify(wc)}`)
const paint = await page.evaluate(() => window.__paintStats)
console.log(`  ペイント経路: ${JSON.stringify(paint)}`)

// OP_PAINT の往復時間を直接計る（キューを介するので実効レイテンシ）。
// xul_paint（RenderDocument 全画面）が遅いのか、ループが枯渇してるのかを分離する。
const lat = await page.evaluate(async () => {
  const eng = window.bib?.source?.engine
  if (!eng?.run) return 'engine.run 未到達'
  const ts = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await eng.run({ op: 4 })
    ts.push(Math.round(performance.now() - t))
  }
  return ts
})
console.log(`  OP_PAINT 往復: ${JSON.stringify(lat)} ms`)
const cmd = await page.evaluate(() => {
  const s = window.__cmdStats
  if (!s) return null
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  const out = {}
  for (const [k, v] of Object.entries(s.times)) {
    out[k] = `n=${v.length} avg=${Math.round(sum(v) / v.length)}ms min=${Math.min(...v)} max=${Math.max(...v)}`
  }
  out.qDepth = `avg=${(sum(s.qDepth) / s.qDepth.length).toFixed(1)} max=${Math.max(...s.qDepth)}`
  return out
})
console.log(`  runCmd 内訳: ${JSON.stringify(cmd)}`)

await browser.close()

const distinct = new Set(seen.map((s) => s.hash))
distinct.delete('nocanvas')
const secs = (seen.at(-1).t - seen[0].t) / 1000
console.log(
  `\n  結果: ${secs.toFixed(1)}s 観測 / ${seen.length} サンプル / ` +
    `ユニークフレーム ${distinct.size} → 実効 ~${(distinct.size / secs).toFixed(1)}fps` +
    `（ソース 30fps、720p）`,
)
const errors = [...distinct].filter((h) => String(h).startsWith('err:'))
if (errors.length) console.log(`  読み取りエラー: ${errors[0]}（GPU モードでは canvas 直接読み不可）`)
if (geckoLog.length) {
  console.log('  エンジンログ:')
  for (const line of geckoLog.slice(-15)) console.log(`    ${line}`)
}
