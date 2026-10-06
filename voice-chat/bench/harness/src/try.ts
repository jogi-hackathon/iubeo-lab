import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveClient } from "./serveClient.ts";

// Local try-it-out: serve the world page + print ONE lobby URL — everyone who
// opens it POSTs /v1/join on the vc service, gets a roster-unique id + JWT,
// and walks straight into the room. Chrome only (WebTransport cert pinning).
export async function tryIt(opts: {
  server: string; media?: string; room: string; transport: string;
}) {
  // wthash = sha256 of the relay's DER cert — computed from the on-disk pem so
  // it stays correct across relay restarts
  let hash = "";
  if (opts.media) {
    const pemPath = fileURLToPath(new URL("../../dev-keys/moq-cert.pem", import.meta.url));
    const der = Buffer.from(
      readFileSync(pemPath, "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""),
      "base64",
    );
    hash = createHash("sha256").update(der).digest("hex");
  }

  const { url } = await serveClient({
    server: opts.server,
    media: opts.media,
    wthash: hash || undefined,
    transport: opts.transport,
  });
  const lobby = url; // "/" is the lobby — zero params, everything's baked in

  console.log(`\n  share this URL — everyone who opens it gets the lobby (Chrome/Edge only):\n`);
  console.log(`    ${lobby}\n`);
  console.log(`  pick a room or type a new name → join → allow mic → WASD to move.`);
  console.log(`  M = mic mute · N = deafen · drag = orbit cam. Ctrl+C to stop.\n`);

  // convenience: open it in Chrome if present (macOS)
  if (existsSync("/Applications/Google Chrome.app")) {
    try {
      execFileSync("open", ["-a", "Google Chrome", lobby]);
    } catch { /* printing the URL above is enough */ }
  }

  await new Promise(() => {}); // keep the server alive
}
