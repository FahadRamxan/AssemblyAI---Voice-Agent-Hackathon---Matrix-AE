/**
 * Identifier, key, and token helpers — all from node:crypto, no deps.
 *
 *  - newId('agt')      -> "agt_<24 hex>"   opaque, unguessable row ids
 *  - newPublicKey()    -> "pk_live_<b62>"  browser-safe publishable embed key
 *  - newSessionToken() -> "<b64url>"       raw session token (shown to client once)
 *  - sha256(s)         -> hex              for token_hash + privacy-preserving ip hash
 *
 * Isolation never depends on ids being unguessable (the WHERE tenant_id clause
 * does that) — random ids are defence in depth.
 */
import { randomBytes, createHash } from "node:crypto";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(buf: Buffer): string {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/** Opaque prefixed id, e.g. newId("agt") -> "agt_9f1c...". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** Publishable browser-safe embed key (Stripe pk_-style). */
export function newPublicKey(): string {
  return `pk_live_${base62(randomBytes(24))}`;
}

/** Opaque session token — the raw value goes in the cookie; only its hash is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex — used for session token_hash and ip hashing. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Current epoch milliseconds (single source so tests can reason about time). */
export function now(): number {
  return Date.now();
}
