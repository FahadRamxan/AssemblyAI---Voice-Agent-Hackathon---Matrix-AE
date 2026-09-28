/**
 * Live Ops — an in-memory registry of calls happening RIGHT NOW, so the owner
 * dashboard can watch active conversations live (agent, elapsed, running
 * transcript, latency) without touching the DB on every poll.
 *
 * The recorder (best-effort, off the audio hot path) feeds this; the dashboard
 * reads it, tenant-scoped. Process-local by design — one server, one registry.
 * Stale entries (a crashed call that never ended) are pruned on read.
 */
export interface LiveCall {
  callId: string;
  tenantId: string;
  agentName: string;
  startedAt: number;
  turnCount: number;
  bargeInCount: number;
  lastCaller: string | null;
  lastAgent: string | null;
  lastLatencyMs: number | null;
  updatedAt: number;
}

const STALE_MS = 15 * 60 * 1000; // drop a call with no update for 15 min (crash safety)

export class LiveOps {
  private calls = new Map<string, LiveCall>();

  constructor(private readonly clock: () => number = Date.now) {}

  start(input: { callId: string; tenantId: string; agentName: string }): void {
    const t = this.clock();
    this.calls.set(input.callId, {
      callId: input.callId,
      tenantId: input.tenantId,
      agentName: input.agentName,
      startedAt: t,
      turnCount: 0,
      bargeInCount: 0,
      lastCaller: null,
      lastAgent: null,
      lastLatencyMs: null,
      updatedAt: t,
    });
  }

  turn(callId: string, role: "caller" | "agent", text: string, latencyMs?: number | null): void {
    const c = this.calls.get(callId);
    if (!c) return;
    if (role === "caller") {
      c.lastCaller = text;
      c.turnCount++;
    } else {
      c.lastAgent = text;
      if (latencyMs && latencyMs > 0) c.lastLatencyMs = latencyMs;
    }
    c.updatedAt = this.clock();
  }

  bargeIn(callId: string): void {
    const c = this.calls.get(callId);
    if (!c) return;
    c.bargeInCount++;
    c.updatedAt = this.clock();
  }

  end(callId: string): void {
    this.calls.delete(callId);
  }

  /** Active calls for a tenant, newest first. Prunes stale entries as a side effect. */
  listForTenant(tenantId: string): LiveCall[] {
    const now = this.clock();
    const out: LiveCall[] = [];
    for (const [id, c] of this.calls) {
      if (now - c.updatedAt > STALE_MS) {
        this.calls.delete(id);
        continue;
      }
      if (c.tenantId === tenantId) out.push(c);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Total active calls across all tenants (for ops/metrics). */
  activeCount(): number {
    return this.calls.size;
  }
}

/** Process-wide singleton shared by the recorder (writer) + dashboard (reader). */
export const liveOps = new LiveOps();
