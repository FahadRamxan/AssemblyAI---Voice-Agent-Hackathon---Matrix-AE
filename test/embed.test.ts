/**
 * Embed-key resolution: the gate the /ws upgrade relies on. If a revoked or
 * inactive key ever resolved, a stranger could open a voice session (leaked
 * provider spend), so these cases are pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";
import { resolveEmbedKey, originAllowed } from "../src/embed.ts";

function seed() {
  const db = openDb(":memory:");
  const tenant = createTenant(db, { name: "Acme" });
  const repo = scopedRepo(db, tenant.id);
  const agent = repo.createAgent({
    name: "Acme agent",
    persona: "You are Acme.",
    greeting: "Hi from Acme",
    keyterms: ["Acme", "Widgets"],
  });
  const key = repo.createEmbedKey({ agentId: agent.id, allowedOrigins: ["https://acme.example"] });
  return { db, tenant, repo, agent, key };
}

test("resolveEmbedKey returns the agent for a live key", () => {
  const { db, tenant, agent, key } = seed();
  const r = resolveEmbedKey(db, key.public_key);
  assert.ok(r);
  assert.equal(r.tenantId, tenant.id);
  assert.equal(r.agentId, agent.id);
  assert.equal(r.persona, "You are Acme.");
  assert.equal(r.greeting, "Hi from Acme");
  assert.deepEqual(r.keyterms, ["Acme", "Widgets"]);
  assert.deepEqual(r.allowedOrigins, ["https://acme.example"]);
  db.close();
});

test("resolveEmbedKey rejects unknown / revoked / inactive", () => {
  const { db, repo, agent, key } = seed();
  assert.equal(resolveEmbedKey(db, "pk_live_nope"), null);
  assert.equal(resolveEmbedKey(db, ""), null);

  // revoked key -> null
  repo.revokeEmbedKey(key.id);
  assert.equal(resolveEmbedKey(db, key.public_key), null);

  // fresh key on an INACTIVE agent -> null (kill-switch)
  const key2 = repo.createEmbedKey({ agentId: agent.id });
  repo.updateAgent(agent.id, { isActive: false });
  assert.equal(resolveEmbedKey(db, key2.public_key), null);
  db.close();
});

test("originAllowed: empty/star = any, else must match", () => {
  assert.equal(originAllowed([], "https://anything"), true); // open demo default
  assert.equal(originAllowed(["*"], "https://anything"), true);
  assert.equal(originAllowed(["https://a.com"], "https://a.com"), true);
  assert.equal(originAllowed(["https://a.com"], "https://evil.com"), false);
  assert.equal(originAllowed(["https://a.com"], undefined), false); // non-browser / missing Origin
});
