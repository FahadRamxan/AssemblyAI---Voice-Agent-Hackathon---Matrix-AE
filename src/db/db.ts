/**
 * SQLite connection — opened once, WAL mode, foreign keys enforced, schema
 * migrated idempotently on boot. Synchronous (better-sqlite3), which keeps the
 * control plane race-free: the /ws upgrade can resolve an embed key inline, and
 * signup is a single atomic transaction.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { log } from "../logger.js";

export type Db = Database.Database;

let singleton: Db | null = null;

/** Where the SQLite file lives. DATA_DIR (env) or ./data, then raabta.db. */
export function resolveDbPath(): string {
  const dataDir = (process.env.DATA_DIR ?? "").trim() || resolve(process.cwd(), "data");
  return resolve(dataDir, "raabta.db");
}

/** Open a database at `dbPath`, apply pragmas + migrations, and return it. */
export function openDb(dbPath: string = resolveDbPath()): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // concurrent dashboard reads during live-call writes
  db.pragma("foreign_keys = ON"); // enforce FKs + cascade deletes
  db.pragma("busy_timeout = 5000"); // wait, don't throw, on a brief writer lock
  db.pragma("synchronous = NORMAL"); // safe with WAL, much faster than FULL
  migrate(db);
  return db;
}

/** Add a column only if it's missing — idempotent, so re-runs on any DB are safe. */
function addColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Additive migrations for DBs created before a column existed. Each is guarded by
 * addColumn(), so this is safe to run on every boot regardless of schema version.
 * Fresh DBs already have these from SCHEMA_SQL; this only backfills older files.
 */
function runAdditiveMigrations(db: Db): void {
  addColumn(db, "calls", "detected_lang", "detected_lang TEXT"); // v2 — AssemblyAI-detected language
  addColumn(db, "calls", "share_token", "share_token TEXT"); // v3 — public shareable report token
  addColumn(db, "calls", "variant", "variant TEXT"); // v4 — persona A/B variant
  addColumn(db, "agents", "persona_b", "persona_b TEXT"); // v4 — A/B variant persona
  addColumn(db, "agents", "ab_enabled", "ab_enabled INTEGER NOT NULL DEFAULT 0"); // v4 — A/B on/off
  db.exec("CREATE INDEX IF NOT EXISTS idx_calls_share ON calls(share_token)");
}

/** Apply the schema (idempotent) and record the version. */
function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  runAdditiveMigrations(db);
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current < SCHEMA_VERSION) {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
    log.info("db migrated", { from: current, to: SCHEMA_VERSION });
  }
}

/** Process-wide singleton (the server uses one connection). */
export function getDb(): Db {
  if (!singleton) singleton = openDb();
  return singleton;
}

/** Checkpoint the WAL and close — called on graceful shutdown. */
export function closeDb(): void {
  if (!singleton) return;
  try {
    singleton.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  singleton.close();
  singleton = null;
}
