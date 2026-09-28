/**
 * The repository layer — the ONE place that talks SQL.
 *
 * Isolation by construction: route handlers never receive the raw better-sqlite3
 * handle. They call `scopedRepo(db, tenantId)` and get an object whose every
 * SELECT/UPDATE/DELETE bakes in `WHERE tenant_id = @tenantId`. A get-by-id like
 * getAgent(id) returns null when the row belongs to another tenant, so a guessed
 * or leaked cross-tenant id is indistinguishable from "not found".
 *
 * Tenant-CROSSING lookups (login by email, resolve by session token, resolve by
 * embed public key) are deliberately NOT here — they are how you *discover* a
 * tenant and live in the auth/embed modules, each returning only what it must.
 */
import type { Db } from "./db.js";
import type { Agent, Call, EmbedKey, Tenant, TranscriptTurn, User } from "./types.js";
import { newId, newPublicKey, newSessionToken, now } from "./ids.js";

// ---- provisioning (tenant-crossing by nature; used by signup + seed) --------

export function createTenant(db: Db, input: { name: string; plan?: string }): Tenant {
  const row: Tenant = {
    id: newId("ten"),
    name: input.name,
    plan: input.plan ?? "free",
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO tenants (id, name, plan, created_at) VALUES (@id, @name, @plan, @created_at)",
  ).run(row);
  return row;
}

export function createUser(
  db: Db,
  input: { tenantId: string; email: string; passwordHash: string; name?: string | null; role?: string },
): User {
  const row: User = {
    id: newId("usr"),
    tenant_id: input.tenantId,
    email: input.email.trim().toLowerCase(),
    password_hash: input.passwordHash,
    name: input.name ?? null,
    role: input.role ?? "owner",
    created_at: now(),
    last_login_at: null,
  };
  db.prepare(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role, created_at, last_login_at)
     VALUES (@id, @tenant_id, @email, @password_hash, @name, @role, @created_at, @last_login_at)`,
  ).run(row);
  return row;
}

// ---- scoped repo (everything below is bound to one tenant) ------------------

export interface CreateAgentInput {
  name: string;
  persona: string;
  personaB?: string | null;
  abEnabled?: boolean;
  greeting?: string;
  language?: string;
  voiceId?: string | null;
  keyterms?: string[];
}

export interface UpdateAgentPatch {
  name?: string;
  persona?: string;
  personaB?: string | null;
  abEnabled?: boolean;
  greeting?: string;
  language?: string;
  voiceId?: string | null;
  keyterms?: string[];
  isActive?: boolean;
}

export interface CreateCallInput {
  agentId: string;
  embedKeyId?: string | null;
  origin?: string | null;
  clientIpHash?: string | null;
  variant?: string | null;
}

export interface AddTurnInput {
  callId: string;
  seq: number;
  role: "caller" | "agent";
  text: string;
  lang?: string | null;
  tsMs?: number | null;
  latencyMs?: number | null;
}

export type ScopedRepo = ReturnType<typeof scopedRepo>;

export function scopedRepo(db: Db, tenantId: string) {
  return {
    tenantId,

    // ---- agents ----
    createAgent(input: CreateAgentInput): Agent {
      const ts = now();
      const row: Agent = {
        id: newId("agt"),
        tenant_id: tenantId,
        name: input.name,
        persona: input.persona,
        persona_b: input.personaB ?? null,
        ab_enabled: input.abEnabled ? 1 : 0,
        greeting: input.greeting ?? "",
        language: input.language ?? "auto",
        voice_id: input.voiceId ?? null,
        keyterms: JSON.stringify(input.keyterms ?? []),
        is_active: 1,
        created_at: ts,
        updated_at: ts,
      };
      db.prepare(
        `INSERT INTO agents (id, tenant_id, name, persona, persona_b, ab_enabled, greeting, language, voice_id, keyterms, is_active, created_at, updated_at)
         VALUES (@id, @tenant_id, @name, @persona, @persona_b, @ab_enabled, @greeting, @language, @voice_id, @keyterms, @is_active, @created_at, @updated_at)`,
      ).run(row);
      return row;
    },

    listAgents(): Agent[] {
      return db
        .prepare("SELECT * FROM agents WHERE tenant_id = @tenantId ORDER BY created_at ASC")
        .all({ tenantId }) as Agent[];
    },

    getAgent(id: string): Agent | null {
      return (
        (db
          .prepare("SELECT * FROM agents WHERE id = @id AND tenant_id = @tenantId")
          .get({ id, tenantId }) as Agent | undefined) ?? null
      );
    },

    updateAgent(id: string, patch: UpdateAgentPatch): Agent | null {
      const existing = this.getAgent(id);
      if (!existing) return null;
      const sets: string[] = [];
      const params: Record<string, unknown> = { id, tenantId, updated_at: now() };
      const put = (col: string, val: unknown) => {
        sets.push(`${col} = @${col}`);
        params[col] = val;
      };
      if (patch.name !== undefined) put("name", patch.name);
      if (patch.persona !== undefined) put("persona", patch.persona);
      if (patch.personaB !== undefined) put("persona_b", patch.personaB);
      if (patch.abEnabled !== undefined) put("ab_enabled", patch.abEnabled ? 1 : 0);
      if (patch.greeting !== undefined) put("greeting", patch.greeting);
      if (patch.language !== undefined) put("language", patch.language);
      if (patch.voiceId !== undefined) put("voice_id", patch.voiceId);
      if (patch.keyterms !== undefined) put("keyterms", JSON.stringify(patch.keyterms));
      if (patch.isActive !== undefined) put("is_active", patch.isActive ? 1 : 0);
      sets.push("updated_at = @updated_at");
      db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = @id AND tenant_id = @tenantId`).run(params);
      return this.getAgent(id);
    },

    // ---- embed keys ----
    createEmbedKey(input: { agentId: string; label?: string; allowedOrigins?: string[] }): EmbedKey {
      const row: EmbedKey = {
        id: newId("key"),
        tenant_id: tenantId,
        agent_id: input.agentId,
        public_key: newPublicKey(),
        label: input.label ?? "default",
        allowed_origins: JSON.stringify(input.allowedOrigins ?? []),
        created_at: now(),
        revoked_at: null,
        last_used_at: null,
      };
      db.prepare(
        `INSERT INTO embed_keys (id, tenant_id, agent_id, public_key, label, allowed_origins, created_at, revoked_at, last_used_at)
         VALUES (@id, @tenant_id, @agent_id, @public_key, @label, @allowed_origins, @created_at, @revoked_at, @last_used_at)`,
      ).run(row);
      return row;
    },

    listEmbedKeys(): EmbedKey[] {
      return db
        .prepare("SELECT * FROM embed_keys WHERE tenant_id = @tenantId ORDER BY created_at DESC")
        .all({ tenantId }) as EmbedKey[];
    },

    revokeEmbedKey(id: string): boolean {
      const res = db
        .prepare(
          "UPDATE embed_keys SET revoked_at = @ts WHERE id = @id AND tenant_id = @tenantId AND revoked_at IS NULL",
        )
        .run({ id, tenantId, ts: now() });
      return res.changes > 0;
    },

    // ---- calls ----
    createCall(input: CreateCallInput): Call {
      const row: Call = {
        id: newId("call"),
        tenant_id: tenantId,
        agent_id: input.agentId,
        embed_key_id: input.embedKeyId ?? null,
        started_at: now(),
        ended_at: null,
        duration_ms: null,
        turn_count: 0,
        barge_in_count: 0,
        language_primary: null,
        detected_lang: null,
        variant: input.variant ?? null,
        share_token: null,
        status: "active",
        ended_reason: null,
        origin: input.origin ?? null,
        client_ip_hash: input.clientIpHash ?? null,
      };
      db.prepare(
        `INSERT INTO calls (id, tenant_id, agent_id, embed_key_id, started_at, ended_at, duration_ms, turn_count, barge_in_count, language_primary, detected_lang, variant, share_token, status, ended_reason, origin, client_ip_hash)
         VALUES (@id, @tenant_id, @agent_id, @embed_key_id, @started_at, @ended_at, @duration_ms, @turn_count, @barge_in_count, @language_primary, @detected_lang, @variant, @share_token, @status, @ended_reason, @origin, @client_ip_hash)`,
      ).run(row);
      return row;
    },

    getCall(id: string): Call | null {
      return (
        (db.prepare("SELECT * FROM calls WHERE id = @id AND tenant_id = @tenantId").get({ id, tenantId }) as
          | Call
          | undefined) ?? null
      );
    },

    listCalls(limit = 100): Call[] {
      return db
        .prepare("SELECT * FROM calls WHERE tenant_id = @tenantId ORDER BY started_at DESC LIMIT @limit")
        .all({ tenantId, limit }) as Call[];
    },

    incTurnCount(callId: string): void {
      db.prepare(
        "UPDATE calls SET turn_count = turn_count + 1 WHERE id = @callId AND tenant_id = @tenantId",
      ).run({ callId, tenantId });
    },

    incBargeIn(callId: string): void {
      db.prepare(
        "UPDATE calls SET barge_in_count = barge_in_count + 1 WHERE id = @callId AND tenant_id = @tenantId",
      ).run({ callId, tenantId });
    },

    finalizeCall(
      callId: string,
      input: { endedReason?: string; languagePrimary?: string | null; detectedLang?: string | null },
    ): void {
      const ended = now();
      db.prepare(
        `UPDATE calls
         SET ended_at = @ended,
             duration_ms = @ended - started_at,
             status = 'completed',
             ended_reason = @endedReason,
             language_primary = COALESCE(@languagePrimary, language_primary),
             detected_lang = COALESCE(@detectedLang, detected_lang)
         WHERE id = @callId AND tenant_id = @tenantId AND ended_at IS NULL`,
      ).run({
        callId,
        tenantId,
        ended,
        endedReason: input.endedReason ?? "client_close",
        languagePrimary: input.languagePrimary ?? null,
        detectedLang: input.detectedLang ?? null,
      });
    },

    /** Generate + persist a public share token for a call (idempotent — returns the existing one). */
    shareCall(callId: string): string | null {
      const call = this.getCall(callId);
      if (!call) return null;
      if (call.share_token) return call.share_token;
      const token = `rpt_${newSessionToken()}`; // long, URL-safe, unguessable
      db.prepare("UPDATE calls SET share_token = @token WHERE id = @callId AND tenant_id = @tenantId").run({
        token,
        callId,
        tenantId,
      });
      return token;
    },

    unshareCall(callId: string): boolean {
      const res = db
        .prepare("UPDATE calls SET share_token = NULL WHERE id = @callId AND tenant_id = @tenantId")
        .run({ callId, tenantId });
      return res.changes > 0;
    },

    // ---- transcript turns ----
    addTurn(input: AddTurnInput): TranscriptTurn {
      const row: TranscriptTurn = {
        id: newId("turn"),
        call_id: input.callId,
        tenant_id: tenantId,
        seq: input.seq,
        role: input.role,
        text: input.text,
        lang: input.lang ?? null,
        ts_ms: input.tsMs ?? null,
        latency_ms: input.latencyMs ?? null,
        created_at: now(),
      };
      db.prepare(
        `INSERT INTO transcript_turns (id, call_id, tenant_id, seq, role, text, lang, ts_ms, latency_ms, created_at)
         VALUES (@id, @call_id, @tenant_id, @seq, @role, @text, @lang, @ts_ms, @latency_ms, @created_at)`,
      ).run(row);
      return row;
    },

    listTurns(callId: string): TranscriptTurn[] {
      return db
        .prepare(
          "SELECT * FROM transcript_turns WHERE call_id = @callId AND tenant_id = @tenantId ORDER BY seq ASC",
        )
        .all({ callId, tenantId }) as TranscriptTurn[];
    },
  };
}
