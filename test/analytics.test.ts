/**
 * Analytics must be real (derived from captured rows) and tenant-scoped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";
import { createRecorder } from "../src/recorder.ts";
import { computeAnalytics, percentile, ASSEMBLYAI_USD_PER_MIN } from "../src/analytics.ts";

test("percentile (nearest-rank)", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([100, 200, 320], 50), 200);
  assert.equal(percentile([100, 200, 320], 95), 320);
  assert.equal(percentile([10], 50), 10);
});

test("analytics are computed from captured calls and scoped per tenant", () => {
  const db = openDb(":memory:");
  const A = createTenant(db, { name: "A" });
  const B = createTenant(db, { name: "B" });
  const repoA = scopedRepo(db, A.id);
  const repoB = scopedRepo(db, B.id);
  const agentA = repoA.createAgent({ name: "a", persona: "p" });
  const agentB = repoB.createAgent({ name: "b", persona: "p" });

  // Tenant A: 2 calls with known turns/latency/barge-in/lang.
  const c1 = repoA.createCall({ agentId: agentA.id });
  const r1 = createRecorder(db, A.id, c1.id);
  r1.callerTurn("hi", "en");
  r1.agentReply("hello", "en", 100);
  r1.callerTurn("book", "en");
  r1.agentReply("sure", "en", 320);
  r1.bargeIn();
  r1.finalize("client_close", "en");

  const c2 = repoA.createCall({ agentId: agentA.id });
  const r2 = createRecorder(db, A.id, c2.id);
  r2.callerTurn("مرحبا", "ar");
  r2.agentReply("اهلا", "ar", 200);
  r2.finalize("client_close", "ar");

  // Tenant B: 1 call — must NOT affect A's analytics.
  const c3 = repoB.createCall({ agentId: agentB.id });
  const r3 = createRecorder(db, B.id, c3.id);
  r3.callerTurn("other tenant", "en");
  r3.finalize("client_close", "en");

  const a = computeAnalytics(db, A.id);
  assert.equal(a.totalCalls, 2); // NOT 3 — B excluded
  assert.equal(a.totalBargeIns, 1);
  assert.equal(a.bargeInRate, 0.5);
  assert.deepEqual(a.languageSplit, { en: 1, ar: 1, unknown: 0 });
  assert.equal(a.latencyMsP50, 200); // [100,200,320] -> p50 200
  assert.equal(a.latencyMsP95, 320);
  assert.equal(a.callsPerDay.length, 14);
  assert.equal(a.callsPerDay[13]?.calls, 2); // today

  const b = computeAnalytics(db, B.id);
  assert.equal(b.totalCalls, 1);
  assert.equal(b.totalBargeIns, 0);

  db.close();
});

test("analytics surface AssemblyAI-detected languages + streaming usage/cost", () => {
  const db = openDb(":memory:");
  const T = createTenant(db, { name: "T" });
  const repo = scopedRepo(db, T.id);
  const agent = repo.createAgent({ name: "a", persona: "p", language: "multi" });

  // Two Spanish calls + one French — as AssemblyAI would tag them on finalize.
  for (const code of ["es", "es", "fr"]) {
    const c = repo.createCall({ agentId: agent.id });
    const r = createRecorder(db, T.id, c.id);
    r.callerTurn("hola", code);
    r.agentReply("hola", code, 120);
    r.finalize("client_close", code === "es" ? "en" : "en", code); // detectedLang = the AssemblyAI code
  }

  const a = computeAnalytics(db, T.id);
  assert.deepEqual(a.detectedLanguages, [
    { code: "es", calls: 2 },
    { code: "fr", calls: 1 },
  ]);
  // usage shape is real (derived from captured durations) + cost = minutes * rate.
  assert.equal(a.usage.usdPerMin, ASSEMBLYAI_USD_PER_MIN);
  assert.equal(typeof a.usage.streamingMinutesMonth, "number");
  assert.equal(typeof a.usage.streamingMinutesTotal, "number");
  assert.equal(a.usage.estCostMonthUsd, Math.round(a.usage.streamingMinutesMonth * ASSEMBLYAI_USD_PER_MIN * 100) / 100);

  db.close();
});
