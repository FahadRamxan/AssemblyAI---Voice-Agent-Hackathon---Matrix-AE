/**
 * Row shapes — exact DB column names (snake_case), so a read is the row with
 * no mapping layer to drift out of sync. JSON-encoded columns (keyterms,
 * allowed_origins) are stored as TEXT and parsed at the edges that need them.
 */
export interface Tenant {
  id: string;
  name: string;
  plan: string;
  created_at: number;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: string;
  created_at: number;
  last_login_at: number | null;
}

export interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  persona: string;
  persona_b: string | null; // optional A/B variant persona
  ab_enabled: number; // 0 | 1 — split traffic between persona and persona_b
  greeting: string;
  language: string;
  voice_id: string | null;
  keyterms: string; // JSON string[]
  is_active: number; // 0 | 1
  created_at: number;
  updated_at: number;
}

export interface EmbedKey {
  id: string;
  tenant_id: string;
  agent_id: string;
  public_key: string;
  label: string;
  allowed_origins: string; // JSON string[]
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface Call {
  id: string;
  tenant_id: string;
  agent_id: string;
  embed_key_id: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  turn_count: number;
  barge_in_count: number;
  language_primary: string | null;
  detected_lang: string | null; // AssemblyAI-detected language code (multilingual agents)
  variant: string | null; // 'A' | 'B' — persona A/B variant used for this call
  share_token: string | null; // set when the owner shares a public read-only report
  status: string; // 'active' | 'completed' | 'error'
  ended_reason: string | null;
  origin: string | null;
  client_ip_hash: string | null;
}

export interface TranscriptTurn {
  id: string;
  call_id: string;
  tenant_id: string;
  seq: number;
  role: string; // 'caller' | 'agent'
  text: string;
  lang: string | null;
  ts_ms: number | null;
  latency_ms: number | null;
  created_at: number;
}
