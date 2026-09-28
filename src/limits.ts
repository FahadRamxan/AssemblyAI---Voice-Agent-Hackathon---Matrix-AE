/**
 * Abuse caps for the public voice plane. Embed keys run in any browser, so a
 * lifted key could burn platform provider spend — these caps bound the blast
 * radius and are enforced AT the /ws upgrade (concurrency) and inside the
 * session (wall-clock), in the same phase the keyed loop ships.
 *
 * In-memory + per-instance (correct for a single Render instance; a distributed
 * cap is a documented scale-up).
 */
export interface LimitConfig {
  /** Max simultaneous live calls per tenant. */
  maxConcurrentPerTenant: number;
  /** Hard cap on a single session's wall-clock (ms) — bounds provider spend. */
  sessionMaxMs: number;
}

export function loadLimits(): LimitConfig {
  return {
    maxConcurrentPerTenant: Number(process.env.MAX_CONCURRENT_CALLS_PER_TENANT) || 5,
    sessionMaxMs: Number(process.env.SESSION_MAX_MS) || 10 * 60 * 1000,
  };
}

/** Counts live calls per tenant; acquire at upgrade, release on socket close. */
export class ConcurrencyTracker {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Reserve a slot for the tenant, or false if it is already at the cap. */
  tryAcquire(tenantId: string): boolean {
    const n = this.counts.get(tenantId) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(tenantId, n + 1);
    return true;
  }

  /** Free a slot (idempotent, never negative). */
  release(tenantId: string): void {
    const n = this.counts.get(tenantId) ?? 0;
    if (n <= 1) this.counts.delete(tenantId);
    else this.counts.set(tenantId, n - 1);
  }

  active(tenantId: string): number {
    return this.counts.get(tenantId) ?? 0;
  }
}
