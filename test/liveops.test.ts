/**
 * Live Ops registry: tracks active calls, tenant-scoped, prunes on end + when stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveOps } from "../src/liveops.ts";

test("tracks active calls, records turns/barge-ins, and isolates tenants", () => {
  let t = 1000;
  const lo = new LiveOps(() => t);
  lo.start({ callId: "c1", tenantId: "A", agentName: "Front" });
  lo.start({ callId: "c2", tenantId: "B", agentName: "Other" });
  lo.turn("c1", "caller", "hi");
  lo.turn("c1", "agent", "hello", 120);
  lo.bargeIn("c1");

  const a = lo.listForTenant("A");
  assert.equal(a.length, 1); // B excluded
  assert.equal(a[0]?.agentName, "Front");
  assert.equal(a[0]?.turnCount, 1);
  assert.equal(a[0]?.bargeInCount, 1);
  assert.equal(a[0]?.lastCaller, "hi");
  assert.equal(a[0]?.lastAgent, "hello");
  assert.equal(a[0]?.lastLatencyMs, 120);
  assert.equal(lo.listForTenant("B").length, 1);

  lo.end("c1");
  assert.equal(lo.listForTenant("A").length, 0);
  assert.equal(lo.activeCount(), 1); // c2 still active
});

test("stale calls (no update past the window) are pruned on read", () => {
  let t = 0;
  const lo = new LiveOps(() => t);
  lo.start({ callId: "x", tenantId: "A", agentName: "A" });
  assert.equal(lo.listForTenant("A").length, 1);
  t = 16 * 60 * 1000; // > 15 min
  assert.equal(lo.listForTenant("A").length, 0);
  assert.equal(lo.activeCount(), 0);
});
