/**
 * The recorder is what makes the dashboard's analytics real — it must persist
 * turns in order, count caller turns + barge-ins, and finalize the call. The
 * greeting (latency 0) must not pollute latency stats.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";
import { createRecorder } from "../src/recorder.ts";

test("recorder persists turns, counts, and finalizes", () => {
  const db = openDb(":memory:");
  const tenant = createTenant(db, { name: "T" });
  const repo = scopedRepo(db, tenant.id);
  const agent = repo.createAgent({ name: "a", persona: "p" });
  const call = repo.createCall({ agentId: agent.id });
  const rec = createRecorder(db, tenant.id, call.id);

  rec.agentReply("Hello, how can I help?", "en", 0); // greeting -> latency null
  rec.callerTurn("I want to book an appointment", "en");
  rec.agentReply("Sure, what day works?", "en", 320);
  rec.bargeIn();
  rec.finalize("client_close", "en");

  const turns = repo.listTurns(call.id);
  assert.equal(turns.length, 3);
  assert.deepEqual(
    turns.map((t) => t.role),
    ["agent", "caller", "agent"],
  );
  assert.equal(turns[0]?.latency_ms, null); // greeting excluded from latency
  assert.equal(turns[2]?.latency_ms, 320);

  const c = repo.getCall(call.id);
  assert.ok(c);
  assert.equal(c.turn_count, 1); // one caller turn
  assert.equal(c.barge_in_count, 1);
  assert.equal(c.status, "completed");
  assert.equal(c.language_primary, "en");
  assert.ok(c.ended_at !== null && c.duration_ms !== null);

  db.close();
});

test("recorder never throws on a broken db", () => {
  const db = openDb(":memory:");
  const tenant = createTenant(db, { name: "T" });
  const rec = createRecorder(db, tenant.id, "call_does_not_exist");
  db.close(); // subsequent writes will throw internally...
  // ...but the recorder swallows them — the audio path must never see an error.
  assert.doesNotThrow(() => {
    rec.callerTurn("hi", "en");
    rec.agentReply("hello", "en", 100);
    rec.bargeIn();
    rec.finalize("client_close", "en");
  });
});
