/**
 * Demo seed. Reproduces the original single-tenant demo as a REAL keyed agent
 * (same persona, greeting, and keyterms) so the built-in demo page keeps working
 * through the multi-tenant /ws path — no keyless fallback (which would be an
 * open, unauthenticated spend hole). Idempotent: the demo key is stashed in
 * schema_meta and reused across restarts.
 */
import type { Db } from "./db/db.js";
import type { Config } from "./config.js";
import { createTenant, scopedRepo } from "./db/repo.js";
import { resolveEmbedKey } from "./embed.js";
import { SYSTEM_PROMPT } from "./agent.js";
import { log } from "./logger.js";

const DEMO_KEY_META = "demo_public_key";

/** Ensure a demo tenant+agent+key exists; return the demo publishable key. */
export function ensureDemoKey(db: Db, cfg: Config): string {
  const existing = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(DEMO_KEY_META) as
    | { value: string }
    | undefined;
  if (existing && resolveEmbedKey(db, existing.value)) return existing.value;

  const tenant = createTenant(db, { name: "Raabta Demo" });
  const repo = scopedRepo(db, tenant.id);
  const agent = repo.createAgent({
    name: "Raabta Demo Agent",
    persona: SYSTEM_PROMPT,
    greeting: cfg.greeting,
    keyterms: ["Raabta", "Matrix AE"],
  });
  const key = repo.createEmbedKey({ agentId: agent.id, label: "demo" });
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(DEMO_KEY_META, key.public_key);
  log.info("seeded demo tenant + agent + embed key", { key: `${key.public_key.slice(0, 16)}…` });
  return key.public_key;
}
