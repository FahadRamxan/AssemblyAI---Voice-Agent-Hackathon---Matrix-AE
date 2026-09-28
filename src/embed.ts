/**
 * Embed-key resolution — the ONLY thing a browser widget authenticates with.
 *
 * A publishable `pk_live_` key maps 1:1 to one agent+tenant. This resolver is
 * tenant-CROSSING by nature (you don't know the tenant until you resolve the
 * key), so it lives here, not in the tenant-scoped repo, and returns ONLY the
 * fields the voice loop needs — never owner/dashboard data.
 *
 * It is called on the /ws upgrade BEFORE the handshake, so a bad/revoked/
 * inactive key never opens an AssemblyAI/LLM/TTS socket (no leaked spend).
 */
import type { Db } from "./db/db.js";
import { now } from "./db/ids.js";

export interface ResolvedAgent {
  embedKeyId: string;
  tenantId: string;
  agentId: string;
  name: string;
  persona: string;
  personaB: string | null;
  abEnabled: boolean;
  greeting: string;
  language: string;
  voiceId: string | null;
  keyterms: string[];
  allowedOrigins: string[];
}

interface Row {
  embed_key_id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  persona: string;
  persona_b: string | null;
  ab_enabled: number;
  greeting: string;
  language: string;
  voice_id: string | null;
  keyterms: string;
  allowed_origins: string;
}

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a publishable key to its agent+tenant, or null if the key is
 * unknown, revoked, or its agent is inactive (a free live kill-switch).
 */
export function resolveEmbedKey(db: Db, publicKey: string): ResolvedAgent | null {
  const key = (publicKey ?? "").trim();
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT ek.id AS embed_key_id, ek.tenant_id, ek.agent_id, ek.allowed_origins,
              a.name, a.persona, a.persona_b, a.ab_enabled, a.greeting, a.language, a.voice_id, a.keyterms
       FROM embed_keys ek
       JOIN agents a ON a.id = ek.agent_id
       WHERE ek.public_key = @key AND ek.revoked_at IS NULL AND a.is_active = 1`,
    )
    .get({ key }) as Row | undefined;
  if (!row) return null;
  return {
    embedKeyId: row.embed_key_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    name: row.name,
    persona: row.persona,
    personaB: row.persona_b,
    abEnabled: row.ab_enabled === 1,
    greeting: row.greeting,
    language: row.language,
    voiceId: row.voice_id,
    keyterms: parseStringArray(row.keyterms),
    allowedOrigins: parseStringArray(row.allowed_origins),
  };
}

/**
 * Pick the persona variant for a call. When A/B is enabled and a B persona
 * exists, split ~50/50; otherwise always variant A (the base persona). Returns
 * the chosen variant label + the persona text to run.
 */
export function chooseVariant(
  agent: Pick<ResolvedAgent, "persona" | "personaB" | "abEnabled">,
  rand: () => number = Math.random,
): { variant: "A" | "B" | null; persona: string } {
  if (agent.abEnabled && agent.personaB && agent.personaB.trim()) {
    return rand() < 0.5 ? { variant: "A", persona: agent.persona } : { variant: "B", persona: agent.personaB };
  }
  return { variant: null, persona: agent.persona };
}

/** Best-effort stamp that a key was used (for the dashboard's last-used view). */
export function touchEmbedKeyUsage(db: Db, embedKeyId: string): void {
  try {
    db.prepare("UPDATE embed_keys SET last_used_at = @ts WHERE id = @id").run({ id: embedKeyId, ts: now() });
  } catch {
    /* never break a connect over a usage stamp */
  }
}

/**
 * Origin allowlist check. Empty list or ["*"] = any origin (open demo embeds).
 *
 * HONEST SCOPE: this is a BROWSER-ONLY defence — browsers set Origin, but a
 * non-browser client can omit or forge it. The real backstops against a lifted
 * key are revocation + per-tenant concurrency/wall-clock caps + rate limits.
 */
export function originAllowed(allowedOrigins: string[], origin: string | undefined): boolean {
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
