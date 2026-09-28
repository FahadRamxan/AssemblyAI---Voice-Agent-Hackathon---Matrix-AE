/**
 * The tripwire. Cross-tenant leakage is the one bug that sinks a multi-tenant
 * platform's credibility, so this runs in the normal `npm test` suite and FAILS
 * THE BUILD on any leak. It seeds two tenants through the real repo layer and
 * asserts tenant A can never read, mutate, or even bump a counter on tenant B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";

function seed(db: ReturnType<typeof openDb>, name: string) {
  const tenant = createTenant(db, { name });
  const repo = scopedRepo(db, tenant.id);
  const agent = repo.createAgent({ name: `${name} agent`, persona: "persona", greeting: "hi" });
  const key = repo.createEmbedKey({ agentId: agent.id });
  const call = repo.createCall({ agentId: agent.id, embedKeyId: key.id });
  repo.addTurn({ callId: call.id, seq: 0, role: "caller", text: `hello from ${name}` });
  return { tenant, repo, agent, key, call };
}

test("cross-tenant isolation: A cannot read B's rows", () => {
  const db = openDb(":memory:");
  const A = seed(db, "A");
  const B = seed(db, "B");

  // A's list queries return only A's rows.
  const agents = A.repo.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.id, A.agent.id);
  const calls = A.repo.listCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, A.call.id);

  // A fetching B's rows by id is indistinguishable from "not found".
  assert.equal(A.repo.getAgent(B.agent.id), null);
  assert.equal(A.repo.getCall(B.call.id), null);
  assert.deepEqual(A.repo.listTurns(B.call.id), []);

  // Symmetric.
  assert.equal(B.repo.getAgent(A.agent.id), null);
  assert.equal(B.repo.getCall(A.call.id), null);

  db.close();
});

test("cross-tenant isolation: A cannot mutate B's rows", () => {
  const db = openDb(":memory:");
  const A = seed(db, "A");
  const B = seed(db, "B");

  // Updating / revoking B's rows through A's scope is a no-op.
  assert.equal(A.repo.updateAgent(B.agent.id, { name: "hacked" }), null);
  assert.equal(A.repo.revokeEmbedKey(B.key.id), false);

  // B's data is untouched.
  assert.equal(B.repo.getAgent(B.agent.id)?.name, "B agent");
  const bKey = B.repo.listEmbedKeys().find((k) => k.id === B.key.id);
  assert.ok(bKey && bKey.revoked_at === null);

  db.close();
});

test("cross-tenant isolation: counters can't cross tenants", () => {
  const db = openDb(":memory:");
  const A = seed(db, "A");
  const B = seed(db, "B");

  // B tries to bump A's call counters through B's scope -> no-op.
  B.repo.incTurnCount(A.call.id);
  B.repo.incBargeIn(A.call.id);
  assert.equal(A.repo.getCall(A.call.id)?.turn_count, 0);
  assert.equal(A.repo.getCall(A.call.id)?.barge_in_count, 0);

  // A bumps its own -> applies.
  A.repo.incTurnCount(A.call.id);
  assert.equal(A.repo.getCall(A.call.id)?.turn_count, 1);

  db.close();
});
