/**
 * Public shared-call reports.
 *
 * A share_token is a bearer capability (long, random, URL-safe) that the owner
 * mints for one call. Resolving it is deliberately TENANT-CROSSING — like an
 * embed key — and returns ONLY safe, read-only fields (no ip hash, no ids,
 * no tenant). Revoking = clearing the token (see repo.unshareCall).
 */
import type { Db } from "./db/db.js";
import type { Call, TranscriptTurn } from "./db/types.js";

export interface PublicReport {
  agentName: string | null;
  startedAt: number;
  durationMs: number | null;
  turnCount: number;
  bargeInCount: number;
  language: string | null; // AssemblyAI-detected, else the coarse primary
  variant: string | null;
  turns: Array<{ role: string; text: string; lang: string | null; latencyMs: number | null }>;
}

export function resolveSharedReport(db: Db, token: string): PublicReport | null {
  const t = (token ?? "").trim();
  if (!t || !t.startsWith("rpt_")) return null;
  const call = db.prepare("SELECT * FROM calls WHERE share_token = ?").get(t) as Call | undefined;
  if (!call) return null;
  const agent = db.prepare("SELECT name FROM agents WHERE id = ?").get(call.agent_id) as { name: string } | undefined;
  const turns = db
    .prepare("SELECT role, text, lang, latency_ms FROM transcript_turns WHERE call_id = ? ORDER BY seq ASC")
    .all(call.id) as Array<Pick<TranscriptTurn, "role" | "text" | "lang" | "latency_ms">>;
  return {
    agentName: agent?.name ?? null,
    startedAt: call.started_at,
    durationMs: call.duration_ms,
    turnCount: call.turn_count,
    bargeInCount: call.barge_in_count,
    language: call.detected_lang ?? call.language_primary,
    variant: call.variant,
    turns: turns.map((t) => ({ role: t.role, text: t.text, lang: t.lang, latencyMs: t.latency_ms })),
  };
}
