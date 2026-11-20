import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export function parsePasswordHash(encoded) {
  const [scheme, costText, blockSizeText, parallelText, saltText, digestText, ...extra] = String(encoded || "").split("$");
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallel = Number(parallelText);
  if (scheme !== "scrypt" || extra.length || !Number.isInteger(cost) || !Number.isInteger(blockSize)
    || !Number.isInteger(parallel) || cost !== 16384 || blockSize !== 8 || parallel !== 1) {
    return null;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const digest = Buffer.from(digestText, "base64url");
    return salt.length >= 16 && digest.length === 64
      ? { cost, blockSize, parallel, salt, digest }
      : null;
  } catch {
    return null;
  }
}

export async function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed || typeof password !== "string" || password.length > 512) return false;
  const candidate = await scrypt(password, parsed.salt, parsed.digest.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallel,
    maxmem: 64 * 1024 * 1024
  });
  return timingSafeEqual(parsed.digest, candidate);
}
