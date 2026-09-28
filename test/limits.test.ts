/**
 * Abuse caps + demo seed. The concurrency tracker is the upgrade-time gate that
 * stops a lifted key from opening unbounded sessions; the seed must be
 * idempotent so restarts don't multiply demo tenants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyTracker } from "../src/limits.ts";
import { openDb } from "../src/db/db.ts";
import { ensureDemoKey } from "../src/seed.ts";
import { resolveEmbedKey } from "../src/embed.ts";

const cfg = {
  port: 8790,
  greeting: "Thanks for calling Raabta.",
  assemblyAiKey: "",
  llm: null,
  tts: null,
};

test("ConcurrencyTracker caps per tenant and releases", () => {
  const t = new ConcurrencyTracker(2);
  assert.equal(t.tryAcquire("A"), true);
  assert.equal(t.tryAcquire("A"), true);
  assert.equal(t.tryAcquire("A"), false); // at cap
  assert.equal(t.tryAcquire("B"), true); // other tenant unaffected
  t.release("A");
  assert.equal(t.tryAcquire("A"), true); // slot freed
  assert.equal(t.active("A"), 2);
});

test("release never goes negative", () => {
  const t = new ConcurrencyTracker(1);
  t.release("X");
  assert.equal(t.active("X"), 0);
  assert.equal(t.tryAcquire("X"), true);
});

test("ensureDemoKey is idempotent and resolves to the demo agent", () => {
  const db = openDb(":memory:");
  const k1 = ensureDemoKey(db, cfg);
  const k2 = ensureDemoKey(db, cfg);
  assert.equal(k1, k2); // same key across calls (idempotent)
  assert.match(k1, /^pk_live_/);
  const resolved = resolveEmbedKey(db, k1);
  assert.ok(resolved);
  assert.equal(resolved.greeting, cfg.greeting);
  assert.deepEqual(resolved.keyterms, ["Raabta", "Matrix AE"]);
  // exactly one demo tenant exists after two ensure calls
  const tenants = db.prepare("SELECT COUNT(*) c FROM tenants").get() as { c: number };
  assert.equal(tenants.c, 1);
  db.close();
});
