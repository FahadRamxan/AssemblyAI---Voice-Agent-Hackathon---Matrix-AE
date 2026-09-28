/**
 * Shareable call reports: a token is a read-only bearer capability that resolves
 * cross-tenant to safe fields only, is idempotent, and is revoked by unshare.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { createTenant, scopedRepo } from "../src/db/repo.ts";
import { createRecorder } from "../src/recorder.ts";
import { resolveSharedReport } from "../src/report.ts";

test("share token exposes a read-only report, is idempotent, and unshare revokes it", () => {
  const db = openDb(":memory:");
  const A = createTenant(db, { name: "A" });
  const repo = scopedRepo(db, A.id);
  const agent = repo.createAgent({ name: "Front desk", persona: "p" });
  const c = repo.createCall({ agentId: agent.id });
  const r = createRecorder(db, A.id, c.id);
  r.callerTurn("hi", "en");
  r.agentReply("hello", "en", 120);
  r.finalize("client_close", "en", "es");

  const token = repo.shareCall(c.id);
  assert.ok(token && token.startsWith("rpt_"));
  assert.equal(repo.shareCall(c.id), token); // idempotent — same token

  const rpt = resolveSharedReport(db, token);
  assert.ok(rpt);
  assert.equal(rpt.agentName, "Front desk");
  assert.equal(rpt.language, "es"); // detected code preferred over coarse primary
  assert.equal(rpt.turns.length, 2);
  assert.equal(rpt.turns[0]?.role, "caller");
  assert.equal(rpt.turns[1]?.role, "agent");
  // only safe fields are exposed
  assert.equal(rpt.turns[0]?.text, "hi");
  assert.ok(!("client_ip_hash" in (rpt.turns[0] ?? {})));

  assert.equal(repo.unshareCall(c.id), true);
  assert.equal(resolveSharedReport(db, token), null); // revoked
  db.close();
});

test("bad / foreign / empty tokens resolve to null", () => {
  const db = openDb(":memory:");
  assert.equal(resolveSharedReport(db, ""), null);
  assert.equal(resolveSharedReport(db, "not_a_token"), null);
  assert.equal(resolveSharedReport(db, "rpt_does_not_exist"), null);
  db.close();
});
