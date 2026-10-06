import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importJWK, SignJWT, type KeyLike } from "jose";

const dir = fileURLToPath(new URL("../../dev-keys/", import.meta.url));
let cached: KeyLike | Uint8Array | null = null;

async function privKey(): Promise<KeyLike | Uint8Array> {
  if (!cached) {
    const jwk = JSON.parse(readFileSync(dir + "private.jwk", "utf8"));
    cached = (await importJWK(jwk, "EdDSA")) as KeyLike;
  }
  return cached;
}

export async function mintToken(playerId: string, room: string, ttlS = 3600): Promise<string> {
  const key = await privKey();
  return new SignJWT({ room })
    .setProtectedHeader({ alg: "EdDSA", kid: "vc-dev" })
    .setIssuer("vc-bench")
    .setSubject(playerId)
    .setIssuedAt()
    .setExpirationTime(`${ttlS}s`)
    .sign(key);
}
