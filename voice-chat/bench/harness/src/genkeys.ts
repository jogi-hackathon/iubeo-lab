// Generates bench/dev-keys/{private,public}.jwk (Ed25519). Dev bench use only.
import { generateKeyPair, exportJWK } from "jose";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../dev-keys/", import.meta.url));
mkdirSync(dir, { recursive: true });

if (existsSync(dir + "private.jwk")) {
  console.log("keys already exist:", dir);
  process.exit(0);
}

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);
priv.kid = "vc-dev";
pub.kid = "vc-dev";
writeFileSync(dir + "private.jwk", JSON.stringify(priv, null, 2));
writeFileSync(dir + "public.jwk", JSON.stringify(pub, null, 2));
console.log("wrote", dir);
