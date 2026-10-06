// Production entrypoint for the lobby + 3D world web client.
//
// Bakes window.__VC_CFG from the environment and serves /, /world and /bench.
// The URL params still win over the baked config, so a bench run can point at
// another server without touching this process.
//
//   VC_SERVER    wss://vc.example.com        (signaling WS + lobby API origin)
//   VC_MEDIA     https://media.example.com:4443  (moq WebTransport origin)
//   VC_TRANSPORT moq | ws-relay | webrtc-mesh | wt-datagram
//   VC_WTHASH    optional base64/hex sha256 of the relay cert. Omit to validate
//                the relay against the system CA store — required for a
//                publicly-trusted certificate, since Chrome refuses a pinned
//                certificate whose validity exceeds 14 days.
//   HOST / PORT  bind address (see serveClient.ts); 127.0.0.1:3000 behind Caddy
import { serveClient } from "../bench/harness/src/serveClient.ts";

const server = process.env.VC_SERVER;
if (!server) throw new Error("VC_SERVER is required (e.g. wss://vc.example.com)");

const cfg = {
  server,
  media: process.env.VC_MEDIA,
  transport: process.env.VC_TRANSPORT ?? "moq",
  wthash: process.env.VC_WTHASH,
};

const { url } = await serveClient(cfg);
console.log(
  `[vc-web] ${url}  server=${cfg.server}  media=${cfg.media ?? "-"}  ` +
    `transport=${cfg.transport}  cert-pin=${cfg.wthash ? "on" : "off"}`,
);
