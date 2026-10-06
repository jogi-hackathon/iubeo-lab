// Generate the production Ed25519 JWK pair the vc service signs JWTs with.
//
//   node deploy/genkeys.mjs /etc/vc/keys [kid]
//
// Same JWK shape as bench/harness/src/genkeys.ts ("x" = public raw key,
// "d" = private seed), but dependency-free (node:crypto) and never written
// inside the repo — the committed bench/dev-keys pair is dev-only and must not
// sign tokens on a public host.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node deploy/genkeys.mjs <dir> [kid]");
  process.exit(2);
}
const kid = process.argv[3] ?? "vc-prod";

mkdirSync(dir, { recursive: true });
if (existsSync(join(dir, "private.jwk"))) {
  console.log("keys already exist, leaving them alone:", dir);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = { ...privateKey.export({ format: "jwk" }), kid };
const pub = { ...publicKey.export({ format: "jwk" }), kid };

const privPath = join(dir, "private.jwk");
writeFileSync(privPath, JSON.stringify(priv, null, 2), { mode: 0o600 });
chmodSync(privPath, 0o600);
writeFileSync(join(dir, "public.jwk"), JSON.stringify(pub, null, 2), { mode: 0o644 });
console.log("wrote", privPath, "and public.jwk in", dir);
