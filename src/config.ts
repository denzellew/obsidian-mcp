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
  /**
   * Configured public URL (PUBLIC_URL). When null, the public origin is
   * derived from the reverse proxy's forwarded headers per request and the
   * WebAuthn rpID is pinned at first-passkey setup.
   */
  publicUrl: URL | null;
  /** True when running in proxy-derived mode (no PUBLIC_URL). */
  derived: boolean;
  /** Fixed WebAuthn rpID (hostname of publicUrl), or a localhost fallback in derived mode. */
  rpId: string;
  /** Fixed origin (origin of publicUrl), or a localhost fallback in derived mode. */
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
  const port = int("PORT", 3000);

  // PUBLIC_URL is optional. When set it pins the origin/rpID (most explicit,
  // best for multi-proxy setups). When unset, we derive the public origin from
  // the reverse proxy's X-Forwarded-* headers per request — the common case
  // when the server always sits behind a single trusted tunnel/proxy.
  const rawUrl = env.PUBLIC_URL;
  let publicUrl: URL | null = null;
  if (rawUrl) {
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
  }

  const derived = publicUrl === null;
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    port,
    publicUrl,
    derived,
    // In derived mode these are only fallbacks for non-request contexts (logging);
    // real values come from resolveOrigin() per request.
    rpId: publicUrl?.hostname ?? "localhost",
    origin: publicUrl?.origin ?? `http://localhost:${port}`,
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
