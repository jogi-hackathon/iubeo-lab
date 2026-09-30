// このプロジェクト専用のローカル wisp サーバ。
//
// WISP は「WebSocket ↔ TCP のリレー」。ブラウザ（このアプリの wasm エンジン）は
// 生の TCP を開けないので、実サイト http(s):// への接続はここを経由する。
// wisp クライアントは第三者のサーバに繋ぐこともできるが、トラフィックが全部
// そのサーバを通るため、普段使いは自分で立てるのが基本（README 参照）。
//
// 起動:
//   npm run wisp            # ws://127.0.0.1:5001 で待ち受け
//   WISP_PORT=5002 npm run wisp
//
// アプリ側はクエリで指定:
//   http://localhost:4173/?wisp=ws://127.0.0.1:5001/
//
// 注意: アプリを https で配信している場合は wss:// が必要（mixed content）。
// ローカル開発（http 配信）なら ws:// のままでよい。
import { server as wisp } from '@mercuryworkshop/wisp-js/server'
import http from 'node:http'

const HOST = process.env.WISP_HOST ?? '127.0.0.1'
const PORT = Number(process.env.WISP_PORT ?? 5001)

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('wisp server (browser-in-browser)')
})

server.on('upgrade', (req, socket, head) => wisp.routeRequest(req, socket, head))

server.on('listening', () => {
  console.log(`[wisp] listening on ws://${HOST}:${PORT}/`)
  console.log(`[wisp] use: http://localhost:4173/?wisp=ws://${HOST}:${PORT}/`)
})

server.listen(PORT, HOST)