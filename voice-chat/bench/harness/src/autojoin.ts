import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveClient } from "./serveClient.ts";

// Walk-in join e2e: two world pages opened with NO id/token — each POSTs
// /v1/join, gets a distinct roster id, and they discover each other.
const { url } = await serveClient();

const pemPath = fileURLToPath(new URL("../../dev-keys/moq-cert.pem", import.meta.url));
const der = Buffer.from(
  readFileSync(pemPath, "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
const hash = createHash("sha256").update(der).digest("hex");

const server = "ws://localhost:8081";
const media = "https://localhost:4443";
const room = `auto-${Date.now().toString(36)}`;
const lobby = `${url}/world?room=${room}&server=${encodeURIComponent(server)}` +
  `&transport=moq&media=${encodeURIComponent(media)}&wthash=${hash}` +
  `&autojoin=1&nomic=1&gl=1&fps=24`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});

type St = { id: string; peers: string[] };
const open = async (extra = "") => {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[pg] ${m.text()}`); });
  await page.goto(lobby + extra);
  await page.waitForFunction(() => (window as any).__state !== undefined, null, { timeout: 30_000 });
  return page;
};

const p1 = await open();
const p2 = await open("&name=bob");
await new Promise((r) => setTimeout(r, 3000));

const s1 = await p1.evaluate(() => (window as any).__state as St);
const s2 = await p2.evaluate(() => (window as any).__state as St);
console.log("p1:", JSON.stringify(s1.id), s1.peers, "p2:", JSON.stringify(s2.id), s2.peers);

const ok =
  s1.id.startsWith("p-") && s2.id === "bob" &&
  s1.peers.includes(s2.id) && s2.peers.includes(s1.id);
console.log(ok ? "AUTOJOIN_PASS" : "AUTOJOIN_FAIL");

await browser.close();
process.exit(ok ? 0 : 1);
