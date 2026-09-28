/**
 * Owner authentication — the dashboard plane. Dependency-light (node:crypto).
 *
 *  - scrypt password hashing (PHC string) + timing-safe verify + a dummy hash
 *    on unknown-email login so response timing doesn't leak account existence.
 *  - Revocable, server-side sessions: the cookie carries an opaque random token;
 *    only its sha256 is stored, so logout = DELETE the row (real revocation) and
 *    "sign out everywhere" = DELETE all rows for the user.
 *  - Signup is ONE transaction that provisions tenant + owner + a default agent
 *    + a default embed key, so a new account is instantly demoable.
 *
 * This plane is separate from the embed/voice plane: an embed key is never
 * accepted here, and this cookie never reaches the voice loop.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Db } from "./db/db.js";
import type { Tenant, User } from "./db/types.js";
import { createTenant, createUser, scopedRepo } from "./db/repo.js";
import { newId, newSessionToken, sha256, now } from "./db/ids.js";
import { SYSTEM_PROMPT } from "./agent.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_PW = 200; // cap input before scrypt (bounds a scrypt-amplified DoS)
const MIN_PW = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = "raabta_sess";

export interface Principal {
  userId: string;
  tenantId: string;
}

// ---- passwords --------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.slice(0, MAX_PW), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, phc: string): boolean {
  const parts = phc.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  let actual: Buffer;
  try {
    actual = scryptSync(password.slice(0, MAX_PW), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Precomputed once so a login on an unknown email still burns one scrypt.
const DUMMY_PHC = hashPassword("timing-equalizer-not-a-real-password");

// ---- sessions ---------------------------------------------------------------

export function createSession(
  db: Db,
  input: { userId: string; tenantId: string; userAgent?: string | null; ip?: string | null },
): { token: string; expiresAt: number } {
  const token = newSessionToken();
  const expiresAt = now() + SESSION_TTL_MS;
  db.prepare(
    `INSERT INTO sessions (id, user_id, tenant_id, token_hash, created_at, expires_at, user_agent, ip)
     VALUES (@id, @user_id, @tenant_id, @token_hash, @created_at, @expires_at, @user_agent, @ip)`,
  ).run({
    id: newId("ses"),
    user_id: input.userId,
    tenant_id: input.tenantId,
    token_hash: sha256(token),
    created_at: now(),
    expires_at: expiresAt,
    user_agent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
  return { token, expiresAt };
}

export function resolveSession(db: Db, rawToken: string): Principal | null {
  if (!rawToken) return null;
  const row = db
    .prepare("SELECT user_id, tenant_id, expires_at FROM sessions WHERE token_hash = ?")
    .get(sha256(rawToken)) as { user_id: string; tenant_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < now()) return null;
  return { userId: row.user_id, tenantId: row.tenant_id };
}

export function revokeSession(db: Db, rawToken: string): void {
  if (rawToken) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(rawToken));
}

export function revokeAllForUser(db: Db, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// ---- users / login / signup -------------------------------------------------

export function findUserByEmail(db: Db, email: string): User | null {
  return (
    (db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as User | undefined) ??
    null
  );
}

export function login(db: Db, email: string, password: string): Principal | null {
  const user = findUserByEmail(db, email);
  if (!user) {
    verifyPassword(password, DUMMY_PHC); // equalize timing — don't leak that the email is unknown
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), user.id);
  return { userId: user.id, tenantId: user.tenant_id };
}

export class SignupError extends Error {
  constructor(public readonly code: "invalid_email" | "weak_password" | "email_taken" | "invalid_workspace") {
    super(code);
  }
}

export function signup(
  db: Db,
  input: { email: string; password: string; workspaceName: string },
): { user: User; tenant: Tenant; principal: Principal } {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SignupError("invalid_email");
  if ((input.password ?? "").length < MIN_PW) throw new SignupError("weak_password");
  const name = (input.workspaceName ?? "").trim();
  if (!name) throw new SignupError("invalid_workspace");
  if (findUserByEmail(db, email)) throw new SignupError("email_taken");

  const provision = db.transaction(() => {
    const tenant = createTenant(db, { name });
    const user = createUser(db, {
      tenantId: tenant.id,
      email,
      passwordHash: hashPassword(input.password),
      name,
    });
    const repo = scopedRepo(db, tenant.id);
    const agent = repo.createAgent({
      name: `${name} Agent`,
      persona: `${SYSTEM_PROMPT}\n- You are the voice receptionist for ${name}.`,
      greeting: `Thanks for calling ${name}. How can I help you today?`,
      keyterms: [name],
    });
    repo.createEmbedKey({ agentId: agent.id, label: "default" });
    return { tenant, user };
  });

  const { tenant, user } = provision();
  return { user, tenant, principal: { userId: user.id, tenantId: tenant.id } };
}

/** {user, tenant} for the dashboard shell (never returns the password hash). */
export function principalContext(
  db: Db,
  p: Principal,
): { user: { id: string; email: string; name: string | null; role: string }; tenant: Tenant } | null {
  const user = db.prepare("SELECT id, email, name, role FROM users WHERE id = ?").get(p.userId) as
    | { id: string; email: string; name: string | null; role: string }
    | undefined;
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(p.tenantId) as Tenant | undefined;
  if (!user || !tenant) return null;
  return { user, tenant };
}

// ---- cookies + middleware ---------------------------------------------------

export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve the owner principal from a Bearer token or the session cookie. */
export function requireOwner(db: Db, headers: IncomingHttpHeaders): Principal | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const p = resolveSession(db, auth.slice(7).trim());
    if (p) return p;
  }
  const cookies = parseCookies(headers["cookie"]);
  return resolveSession(db, cookies[SESSION_COOKIE] ?? "");
}
