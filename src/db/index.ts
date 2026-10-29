import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../log.ts";

const log = logger("db");

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export function openDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  );
  const applied = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name),
  );
  const glob = new Bun.Glob("*.sql");
  const files = [...glob.scanSync(MIGRATIONS_DIR)].sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    })();
    log.info(`applied migration ${file}`);
  }
}

export function getSetting(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function deleteSetting(db: Database, key: string) {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}

/** The vault that predates multi-vault support; legacy /mcp and old credentials map to it. */
export const DEFAULT_VAULT_ID = 1;

/** Key/value settings owned by one vault (guidance, sync state). */
export interface VaultSettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function vaultSettings(db: Database, vaultId: number): VaultSettings {
  return {
    get: (key) =>
      db
        .query<{ value: string }, [number, string]>("SELECT value FROM vault_settings WHERE vault_id = ? AND key = ?")
        .get(vaultId, key)?.value ?? null,
    set: (key, value) =>
      void db
        .query(
          "INSERT INTO vault_settings (vault_id, key, value) VALUES (?, ?, ?) ON CONFLICT(vault_id, key) DO UPDATE SET value = excluded.value",
        )
        .run(vaultId, key, value),
    delete: (key) => void db.query("DELETE FROM vault_settings WHERE vault_id = ? AND key = ?").run(vaultId, key),
  };
}
