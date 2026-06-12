import { join } from "node:path";

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface Config {
  port: number;
  publicUrl: URL;
  /** WebAuthn relying-party ID — hostname of publicUrl */
  rpId: string;
  /** Expected WebAuthn / CORS origin — origin of publicUrl */
  origin: string;
  dataDir: string;
  vaultDir: string;
  dbPath: string;
  obConfigDir: string;
  snapshotsDir: string;
  obBin: string;
  syncAutostart: boolean;
  obKillGraceMs: number;
  snapshotDebounceMs: number;
  snapshotMaxWaitMs: number;
  snapshotIntervalMs: number;
  snapshotRetentionDays: number;
  authReset: boolean;
  production: boolean;
}

export function loadConfig(env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const rawUrl = env.PUBLIC_URL ?? (production ? undefined : "http://localhost:3000");
  if (!rawUrl) {
    throw new Error("PUBLIC_URL is required in production (e.g. https://notes.example.com)");
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const isLocalhost = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
  if (publicUrl.protocol !== "https:" && !isLocalhost) {
    throw new Error("PUBLIC_URL must be https:// (passkeys require a secure context), except on localhost");
  }
  if (publicUrl.pathname !== "/") {
    throw new Error("PUBLIC_URL must not have a path component");
  }

  const dataDir = env.DATA_DIR ?? "./data";
  return {
    port: int("PORT", 3000),
    publicUrl,
    rpId: publicUrl.hostname,
    origin: publicUrl.origin,
    dataDir,
    vaultDir: env.VAULT_DIR ?? join(dataDir, "Vault"),
    dbPath: env.DB_PATH ?? join(dataDir, "db", "app.db"),
    obConfigDir: env.OB_CONFIG_DIR ?? join(dataDir, "obsidian-headless"),
    snapshotsDir: env.SNAPSHOTS_DIR ?? join(dataDir, "snapshots"),
    obBin: env.OB_BIN ?? "ob",
    syncAutostart: bool("SYNC_AUTOSTART", true),
    obKillGraceMs: int("OB_KILL_GRACE_MS", 5000),
    snapshotDebounceMs: int("SNAPSHOT_DEBOUNCE_MS", 30_000),
    snapshotMaxWaitMs: int("SNAPSHOT_MAX_WAIT_MS", 300_000),
    snapshotIntervalMs: int("SNAPSHOT_INTERVAL_MS", 3_600_000),
    snapshotRetentionDays: int("SNAPSHOT_RETENTION_DAYS", 90),
    authReset: bool("AUTH_RESET", false),
    production,
  };
}
