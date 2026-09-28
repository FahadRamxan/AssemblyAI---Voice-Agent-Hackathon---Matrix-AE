/**
 * Persona A/B testing: variant selection is deterministic given rand(), and
 * per-variant metrics are computed from real captured calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";
import { createRecorder } from "../src/recorder.ts";
import { computeAbStats } from "../src/analytics.ts";
import { chooseVariant } from "../src/embed.ts";

test("chooseVariant: off (or no B) → always the base persona, no variant", () => {
  assert.deepEqual(chooseVariant({ persona: "P", personaB: null, abEnabled: false }), { variant: null, persona: "P" });
  assert.deepEqual(chooseVariant({ persona: "P", personaB: "", abEnabled: true }), { variant: null, persona: "P" });
  assert.deepEqual(chooseVariant({ persona: "P", personaB: "B", abEnabled: false }), { variant: null, persona: "P" });
});

test("chooseVariant: on → splits ~50/50 and returns the matching persona", () => {
  assert.deepEqual(chooseVariant({ persona: "A", personaB: "B", abEnabled: true }, () => 0.1), { variant: "A", persona: "A" });
  assert.deepEqual(chooseVariant({ persona: "A", personaB: "B", abEnabled: true }, () => 0.9), { variant: "B", persona: "B" });
});

test("computeAbStats: per-variant metrics from captured calls", () => {
  const db = openDb(":memory:");
  const T = createTenant(db, { name: "T" });
  const repo = scopedRepo(db, T.id);
  const agent = repo.createAgent({ name: "a", persona: "A", personaB: "B", abEnabled: true });

  const cA = repo.createCall({ agentId: agent.id, variant: "A" });
  const rA = createRecorder(db, T.id, cA.id);
  rA.callerTurn("hi", "en");
  rA.agentReply("hello", "en", 100);
  rA.bargeIn();
  rA.finalize("client_close", "en");

  const cB = repo.createCall({ agentId: agent.id, variant: "B" });
  const rB = createRecorder(db, T.id, cB.id);
  rB.callerTurn("hi", "en");
  rB.agentReply("hello", "en", 300);
  rB.finalize("client_close", "en");

  const stats = computeAbStats(db, T.id, agent.id);
  assert.equal(stats.length, 2);
  const A = stats.find((s) => s.variant === "A");
  const B = stats.find((s) => s.variant === "B");
  assert.equal(A?.calls, 1);
  assert.equal(A?.bargeInRate, 1);
  assert.equal(A?.latencyMsP50, 100);
  assert.equal(B?.calls, 1);
  assert.equal(B?.bargeInRate, 0);
  assert.equal(B?.latencyMsP50, 300);
  db.close();
});
