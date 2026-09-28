/**
 * Dashboard analytics — tenant-scoped SQL aggregates over the REAL captured
 * calls + transcript_turns (nothing seeded or fabricated). Every query filters
 * WHERE tenant_id = ?, so a tenant only ever sees its own numbers.
 *
 * The headline barge-in rate is a genuine differentiator surfaced as a metric:
 * the app's signature feature, now measured per call.
 */
import type { Db } from "./db/db.js";
import { now } from "./db/ids.js";

export interface Analytics {
  totalCalls: number;
  callsLast7Days: number;
  avgDurationMs: number;
  avgTurnsPerCall: number;
  totalBargeIns: number;
  bargeInRate: number; // barge-ins per call
  languageSplit: { en: number; ar: number; unknown: number };
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  callsPerDay: Array<{ date: string; calls: number }>; // last 14 days, zero-filled
}

/** Nearest-rank percentile of an ascending-sorted array (0..100). */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function computeAnalytics(db: Db, tenantId: string): Analytics {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const total = db.prepare("SELECT COUNT(*) c FROM calls WHERE tenant_id = ?").get(tenantId) as { c: number };
  const since7 = now() - 7 * DAY_MS;
  const week = db
    .prepare("SELECT COUNT(*) c FROM calls WHERE tenant_id = ? AND started_at >= ?")
    .get(tenantId, since7) as { c: number };

  const agg = db
    .prepare(
      `SELECT AVG(duration_ms) avgDur, AVG(turn_count) avgTurns, SUM(barge_in_count) barge
       FROM calls WHERE tenant_id = ?`,
    )
    .get(tenantId) as { avgDur: number | null; avgTurns: number | null; barge: number | null };

  const langRows = db
    .prepare("SELECT language_primary lang, COUNT(*) c FROM calls WHERE tenant_id = ? GROUP BY language_primary")
    .all(tenantId) as Array<{ lang: string | null; c: number }>;
  const languageSplit = { en: 0, ar: 0, unknown: 0 };
  for (const r of langRows) {
    if (r.lang === "en") languageSplit.en += r.c;
    else if (r.lang === "ar") languageSplit.ar += r.c;
    else languageSplit.unknown += r.c;
  }

  const latRows = db
    .prepare(
      "SELECT latency_ms FROM transcript_turns WHERE tenant_id = ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC",
    )
    .all(tenantId) as Array<{ latency_ms: number }>;
  const latencies = latRows.map((r) => r.latency_ms);

  // calls per day, last 14 days, zero-filled
  const since14 = now() - 14 * DAY_MS;
  const dayRows = db
    .prepare(
      `SELECT started_at FROM calls WHERE tenant_id = ? AND started_at >= ?`,
    )
    .all(tenantId, since14) as Array<{ started_at: number }>;
  const counts = new Map<string, number>();
  for (const r of dayRows) counts.set(isoDay(r.started_at), (counts.get(isoDay(r.started_at)) ?? 0) + 1);
  const callsPerDay: Array<{ date: string; calls: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const date = isoDay(now() - i * DAY_MS);
    callsPerDay.push({ date, calls: counts.get(date) ?? 0 });
  }

  const totalCalls = num(total.c);
  const totalBargeIns = num(agg.barge);
  return {
    totalCalls,
    callsLast7Days: num(week.c),
    avgDurationMs: Math.round(num(agg.avgDur)),
    avgTurnsPerCall: Math.round(num(agg.avgTurns) * 10) / 10,
    totalBargeIns,
    bargeInRate: totalCalls > 0 ? Math.round((totalBargeIns / totalCalls) * 100) / 100 : 0,
    languageSplit,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    callsPerDay,
  };
}
