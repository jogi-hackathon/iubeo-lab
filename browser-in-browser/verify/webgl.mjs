// wasm エンジンの GPU 合成モードで「コンテンツの WebGL」が動き、かつ
// その結果がホスト側の CanvasTexture として読めることを確かめる。
//
//   npm run build && npx vite preview --port 4173 &
//   npm run verify:webgl
//
// なぜ GPU モードなのか:
//   JS から見える WebGL（canvas.getContext('webgl')）は Gecko では必ず
//   out-of-process canvas IPC を通る（ClientWebGLContext::CreateHostContext →
//   CanvasManagerChild）。ソフトウェア合成（RenderDocument + SWGL）には
//   コンポジタが居ないので、WebGL は !CanvasManagerChild::Get() で失敗する。
//   GECKO_GPU=1 のときだけコンポジタが居るので WebGL が作れる。
//
// なぜ GECKO_GL_PASSTHROUGH も要るのか:
//   コンポジタが居ても、コンテンツ用の GL コンテキストは
//   GLContextProviderEmscripten::CreateHeadless が GECKO_GL_PASSTHROUGH を
//   見て作る。設定しないと FEATURE_FAILURE_EMSCRIPTEN_NO_PASSTHROUGH で
//   静かに失敗する。
//
// 確認すること:
//   1. エンジンが GPU モードで起動する
//   2. エンジン内のページが WebGL2 コンテキストを作れる
//   3. #screen は転送後も「画像ソース」として生きている（drawImage / texImage2D）
//   4. アプリが毎フレーム CanvasTexture を読み直している（liveSurface）
//      -- エンジンの GPU モードはこちらへフレーム通知を出さないので、
//         これが無いと画面が黒いままになる（実測）
//   5. クリティカルなエラーが出ていない

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.SHOT_DIR ?? 'verify/shots'
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 240_000)
mkdirSync(OUT, { recursive: true })

const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures.push(name)
}

// エンジン側で使うフラグの組。GPU 合成 + コンテンツ WebGL。
const PARAMS = 'env.GECKO_GPU=1&env.GECKO_GL_PASSTHROUGH=1'

// エンジンに読ませるページ（ASCII・data URL なので 8192 バイト制限に収まる）。
// 上半分を WebGL で緑に塗る。ホスト側のサンプリングでこの色を探す。
const PAGE =
  '<!doctype html><html><head><title>gl</title></head>' +
  '<body style="margin:0;background:#222">' +
  '<canvas id=c width=300 height=200></canvas><script>' +
  "var c=document.getElementById('c');var msg='(none)';" +
  "c.addEventListener('webglcontextcreationerror',function(e){msg=e.statusMessage||'(empty)';});" +
  "var gl=c.getContext('webgl2')||c.getContext('webgl');" +
  "document.title=gl?('GL_OK:'+gl.getParameter(gl.VERSION)):('GL_FAIL:'+msg);" +
  'if(gl){gl.clearColor(0,0.8,0.2,1);gl.clear(gl.COLOR_BUFFER_BIT);}' +
  '</' +
  'script></body></html>'
const DATA_URL = `data:text/html;base64,${Buffer.from(PAGE, 'utf8').toString('base64')}`

/** 3D の画面（CRT テクスチャ）がモニタに出ているかを、実際の canvas 画素で見る。 */
async function sampleScreen(page) {
  // GPU モードの #screen は Renderer スレッドの OffscreenCanvas へ制御が移っている。
  // placeholder の <canvas> は「画像ソース」としては生きているので、
  // three と同じ経路（texImage2D → readPixels）で内容を読める。
  return page.evaluate(() => {
    const src = window.bib.source.canvas
    const out = { transferred: !!src.controlTransferredOffscreen, error: null, green: 0, nonBg: 0 }
    try {
      const c = document.createElement('canvas')
      c.width = 320
      c.height = 240
      const gl = c.getContext('webgl2')
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
      const err = gl.getError()
      if (err !== 0) out.error = `glError ${err}`
      const fb = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const px = new Uint8Array(c.width * c.height * 4)
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 1] > 140 && px[i] < 120 && px[i + 2] < 120) out.green += 1
        if (px[i] > 45 || px[i + 1] > 45 || px[i + 2] > 45) out.nonBg += 1
      }
    } catch (e) {
      out.error = `${e.name}: ${e.message}`
    }
    return out
  })
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
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
})

console.log(`  URL: ${BASE}/?${PARAMS}`)
await page.goto(`${BASE}/?${PARAMS}`, { waitUntil: 'load' })
await page.waitForSelector('#root canvas', { timeout: 20_000 })
await page.waitForTimeout(2500)

// ---- 1. エンジンを GPU モードで起動する ----------------------------------------
const bootStarted = Date.now()
await page.click('.hud__source >> nth=1')
let status = 'booting'
let lastDetail = ''
const deadline = Date.now() + BOOT_TIMEOUT_MS
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({
    status: window.bib.source.status,
    detail: window.bib.source.statusDetail,
  }))
  if (state.detail !== lastDetail) {
    lastDetail = state.detail
    console.log(`  [${Math.round((Date.now() - bootStarted) / 1000)}s] ${state.status}: ${state.detail}`)
  }
  if (['ready', 'error', 'unavailable'].includes(state.status)) {
    status = state.status
    break
  }
  await page.waitForTimeout(1000)
}
check('エンジンが ready になった', status === 'ready', status)
if (status !== 'ready') {
  check('致命的なエラーが無い', errors.length === 0, errors.slice(0, 4).join(' | '))
  await browser.close()
  process.exit(1)
}

// ---- 2. コンテンツの WebGL が動く ---------------------------------------------
await page.evaluate((url) => window.bib.source.navigate(url), DATA_URL)
await page.waitForTimeout(4000)

const title = await page.evaluate(() => window.bib.source.engine.evalChrome('document.title'))
console.log(`  エンジン内の document.title: ${JSON.stringify(title)}`)
check('エンジン内で WebGL2 コンテキストが作れる', /^GL_OK:WebGL 2\.0/.test(String(title)), String(title))

// ---- 3+4. ホスト側が毎フレーム読めている ---------------------------------------
const live = await page.evaluate(async () => {
  const source = window.bib.source
  const texture = window.bib.runtime.material.map
  const v0 = texture.version
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return {
    liveSurface: source.liveSurface,
    imageIsSourceCanvas: texture.image === source.canvas,
    uploads: texture.version - v0,
  }
})
console.log(`  テクスチャ: liveSurface=${live.liveSurface} 再アップロード=${live.uploads} 回/1.5s`)
check('GPU モードのソースが liveSurface になっている', live.liveSurface === true)
check('CanvasTexture の元がエンジンの canvas', live.imageIsSourceCanvas === true)
check('毎フレーム再アップロードされている', live.uploads > 1, `${live.uploads} 回/1.5s`)

// エンジンがフレームを present するタイミングは非同期なので、数回リトライする。
let sample = null
const sampleDeadline = Date.now() + 20_000
while (Date.now() < sampleDeadline) {
  sample = await sampleScreen(page)
  if (sample.green > 0) break
  await page.waitForTimeout(500)
}
console.log(`  ホスト側のサンプリング: ${JSON.stringify(sample)}`)
check('#screen を画像ソースとして例外なく読める', sample !== null && sample.error === null, String(sample?.error))
check('エンジンの描画（WebGL の緑）がテクスチャに載っている', sample !== null && sample.green > 0, `green=${sample?.green}`)

await page.screenshot({ path: `${OUT}/webgl-gpu.png` })
console.log(`  スクリーンショット: ${OUT}/webgl-gpu.png`)

check('致命的なエラーが無い', errors.length === 0, errors.slice(0, 4).join(' | '))

await browser.close()

console.log()
if (failures.length) {
  console.log(`  ${failures.length} 項失敗: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('  すべて通過')
