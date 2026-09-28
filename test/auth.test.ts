/**
 * Owner auth: password hashing, revocable sessions, atomic signup, and the
 * requireOwner gate. The security-critical cases are pinned — wrong password
 * fails, an unknown email still returns null (no enumeration), a revoked
 * session stops resolving, and signup provisions a complete, instantly-usable
 * workspace atomically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { scopedRepo } from "../src/db/repo.ts";
import { resolveEmbedKey } from "../src/embed.ts";
import { RateLimiter } from "../src/limits.ts";
import {
  hashPassword,
  verifyPassword,
  signup,
  login,
  SignupError,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllForUser,
  requireOwner,
  parseCookies,
  SESSION_COOKIE,
  principalContext,
} from "../src/auth.ts";

test("password hash round-trips; wrong password fails", () => {
  const phc = hashPassword("correct horse battery staple");
  assert.match(phc, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword("correct horse battery staple", phc), true);
  assert.equal(verifyPassword("wrong", phc), false);
  assert.equal(verifyPassword("x", "not-a-phc-string"), false);
});

test("signup provisions tenant+owner+agent+key atomically", () => {
  const db = openDb(":memory:");
  const { user, tenant, principal } = signup(db, {
    email: "Owner@Acme.com",
    password: "supersecret",
    workspaceName: "Acme Clinic",
  });
  assert.equal(user.email, "owner@acme.com"); // lowercased
  assert.equal(tenant.name, "Acme Clinic");
  assert.equal(principal.tenantId, tenant.id);

  const repo = scopedRepo(db, tenant.id);
  const agents = repo.listAgents();
  assert.equal(agents.length, 1);
  const keys = repo.listEmbedKeys();
  assert.equal(keys.length, 1);
  // the seeded key actually resolves to the new agent (instantly demoable)
  const resolved = resolveEmbedKey(db, keys[0]!.public_key);
  assert.ok(resolved);
  assert.equal(resolved.agentId, agents[0]!.id);
  db.close();
});

test("signup rejects bad input and duplicate email", () => {
  const db = openDb(":memory:");
  assert.throws(() => signup(db, { email: "nope", password: "supersecret", workspaceName: "X" }), SignupError);
  assert.throws(() => signup(db, { email: "a@b.com", password: "short", workspaceName: "X" }), SignupError);
  assert.throws(() => signup(db, { email: "a@b.com", password: "supersecret", workspaceName: "" }), SignupError);
  signup(db, { email: "dup@b.com", password: "supersecret", workspaceName: "X" });
  assert.throws(
    () => signup(db, { email: "dup@b.com", password: "supersecret", workspaceName: "Y" }),
    (e) => e instanceof SignupError && e.code === "email_taken",
  );
  db.close();
});

test("login: correct -> principal, wrong/unknown -> null (no enumeration)", () => {
  const db = openDb(":memory:");
  signup(db, { email: "u@b.com", password: "supersecret", workspaceName: "X" });
  assert.ok(login(db, "u@b.com", "supersecret"));
  assert.equal(login(db, "u@b.com", "wrongpass"), null);
  assert.equal(login(db, "ghost@b.com", "whatever"), null); // unknown email -> null (dummy hash ran)
  db.close();
});

test("sessions are revocable (logout + sign-out-everywhere)", () => {
  const db = openDb(":memory:");
  const { principal } = signup(db, { email: "u@b.com", password: "supersecret", workspaceName: "X" });
  const a = createSession(db, { userId: principal.userId, tenantId: principal.tenantId });
  const b = createSession(db, { userId: principal.userId, tenantId: principal.tenantId });
  assert.ok(resolveSession(db, a.token));
  assert.ok(resolveSession(db, b.token));
  revokeSession(db, a.token);
  assert.equal(resolveSession(db, a.token), null); // logged out
  assert.ok(resolveSession(db, b.token)); // other device still valid
  revokeAllForUser(db, principal.userId);
  assert.equal(resolveSession(db, b.token), null); // signed out everywhere
  db.close();
});

test("requireOwner resolves via cookie and Bearer; principalContext hides the hash", () => {
  const db = openDb(":memory:");
  const { principal } = signup(db, { email: "u@b.com", password: "supersecret", workspaceName: "X" });
  const { token } = createSession(db, { userId: principal.userId, tenantId: principal.tenantId });

  const viaCookie = requireOwner(db, { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(viaCookie?.userId, principal.userId);
  const viaBearer = requireOwner(db, { authorization: `Bearer ${token}` });
  assert.equal(viaBearer?.userId, principal.userId);
  assert.equal(requireOwner(db, {}), null);

  const ctx = principalContext(db, principal);
  assert.equal(ctx?.user.email, "u@b.com");
  assert.equal("password_hash" in (ctx?.user ?? {}), false);
  db.close();
});

test("parseCookies + RateLimiter", () => {
  const c = parseCookies(`a=1; ${SESSION_COOKIE}=tok%20en; b=2`);
  assert.equal(c[SESSION_COOKIE], "tok en");

  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.check("ip", 0), true);
  assert.equal(rl.check("ip", 100), true);
  assert.equal(rl.check("ip", 200), false); // over cap in window
  assert.equal(rl.check("ip", 1300), true); // window slid
});
