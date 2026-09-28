/**
 * The multi-tenant schema. Inlined as a string (not a .sql file) so it
 * compiles into dist automatically — the Dockerfile only copies dist/, and
 * tsc doesn't copy loose .sql files.
 *
 * Isolation model: every row that belongs to a customer carries `tenant_id`,
 * denormalized all the way down to calls + transcript_turns so a scope check
 * is always a single-table `WHERE tenant_id = ?` — never dependent on a join
 * staying correct. All statements are idempotent (CREATE ... IF NOT EXISTS);
 * `schema_meta.schema_version` gates future additive migrations.
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The isolation root. One workspace/account = one tenant.
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

-- Dashboard owners. v1 = one owner per tenant (role left to grow into RBAC).
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- Revocable, server-side owner sessions. The cookie carries an opaque random
-- token; only its sha256 is stored here, so a DB dump yields no usable session.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- The per-tenant agent config the voice loop resolves: persona, greeting,
-- voice, keyterms, language. This is what an embed key points at.
CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  persona    TEXT NOT NULL,
  persona_b  TEXT,
  ab_enabled INTEGER NOT NULL DEFAULT 0,
  greeting   TEXT NOT NULL DEFAULT '',
  language   TEXT NOT NULL DEFAULT 'auto',
  voice_id   TEXT,
  keyterms   TEXT NOT NULL DEFAULT '[]',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);

-- Browser-safe publishable keys (pk_live_...). Maps 1:1 to one agent+tenant.
-- Grants ONLY "open a voice session as this agent" — never owner/dashboard scope.
CREATE TABLE IF NOT EXISTS embed_keys (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL DEFAULT 'default',
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  last_used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_embed_keys_agent  ON embed_keys(agent_id);
CREATE INDEX IF NOT EXISTS idx_embed_keys_tenant ON embed_keys(tenant_id);

-- One row per /ws voice session = the analytics fact table.
CREATE TABLE IF NOT EXISTS calls (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  embed_key_id   TEXT REFERENCES embed_keys(id) ON DELETE SET NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  duration_ms    INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  barge_in_count INTEGER NOT NULL DEFAULT 0,
  language_primary TEXT,
  detected_lang  TEXT,
  variant        TEXT,
  share_token    TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  ended_reason   TEXT,
  origin         TEXT,
  client_ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_tenant_started ON calls(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_share ON calls(share_token);

-- The persisted read-along transcript, one row per finalized turn.
-- tenant_id denormalized so a transcript read is scoped without a join.
CREATE TABLE IF NOT EXISTS transcript_turns (
  id         TEXT PRIMARY KEY,
  call_id    TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  lang       TEXT,
  ts_ms      INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_call   ON transcript_turns(call_id, seq);
CREATE INDEX IF NOT EXISTS idx_turns_tenant ON transcript_turns(tenant_id);
`;
