import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveClient } from "./serveClient.ts";

// Lobby e2e: open "/", type a room name, create → world joins with no creds;
// a second lobby visitor sees the now-live room + member.
const pemPath = fileURLToPath(new URL("../../dev-keys/moq-cert.pem", import.meta.url));
const der = Buffer.from(
  readFileSync(pemPath, "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
const hash = createHash("sha256").update(der).digest("hex");

const { url } = await serveClient({
  server: "ws://localhost:8081",
  media: "https://localhost:4443",
  wthash: hash,
  transport: "moq",
});

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[pg]", m.text()); });
await page.goto(`${url}/`);
await page.waitForSelector("#rooms li", { timeout: 5000 });
await page.fill("#nm", "tester");
await page.fill("#rn", "lobbyroom");
await page.click("#mk");
await page.waitForURL(/\/world\?/, { timeout: 5000 });
console.log("URL:", page.url());
await page.waitForSelector("#gate", { state: "visible", timeout: 5000 });
await page.click("#gate");
await page.waitForFunction(() => (window as any).__state !== undefined, null, { timeout: 30000 });
const s = await page.evaluate(() => (window as any).__state);
console.log("JOINED as", s.id, "in", s.room);

const p2 = await browser.newPage();
await p2.goto(`${url}/`);
await p2.waitForFunction(
  () => [...document.querySelectorAll("#rooms li")].some((li) => li.textContent!.includes("lobbyroom") && li.textContent!.includes("tester")),
  null, { timeout: 8000 });
console.log("LOBBY_PASS");
await browser.close();
