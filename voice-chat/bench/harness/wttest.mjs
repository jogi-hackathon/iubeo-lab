import { chromium } from "playwright";
import { createServer } from "node:http";
import { mintToken } from "./src/keys.ts";

const token = await mintToken("wt-dbg", "room-dbg");

const srv = createServer((req, res) => res.end("<html><body>ok</body>"));
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => console.log("[console]", m.text()));
await p.goto(`http://127.0.0.1:${port}/`);

const r = await p.evaluate(async ({ token, URL_OVERRIDE }) => {
  try {
    const { url, hash } = await fetch("http://localhost:8091/wtcert").then((r) => r.json());
    const target = URL_OVERRIDE || url;
    const wt = new WebTransport(target + "?token=" + encodeURIComponent(token), {
      serverCertificateHashes: [{ algorithm: "sha-256", value: Uint8Array.from(atob(hash), c=>c.charCodeAt(0)).buffer }],
    });
    wt.closed.then((i)=>console.log("closed", JSON.stringify(i)));
    await Promise.race([wt.ready.then(()=>"READY"), new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),8000))]);
    return "connected";
  } catch (e) { return "ERR " + e.name + " | " + e.message + " | " + (e.source||"") + " | " + (e.streamErrorCode??""); }
}, { token, URL_OVERRIDE: process.env.WTURL || "" });
console.log("result:", r);
await b.close();
srv.close();
