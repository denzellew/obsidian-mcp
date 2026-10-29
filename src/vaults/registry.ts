import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.ts";
import { DEFAULT_VAULT_ID, vaultSettings, type VaultSettings } from "../db/index.ts";
import { createVaultContext, type VaultContext } from "../mcp/context.ts";
import { Snapshotter } from "../snapshots/snapshotter.ts";
import { SyncSupervisor } from "../sync/supervisor.ts";
import { LinkIndex } from "../vault/links.ts";
import { VaultStore } from "../vault/store.ts";
import { logger } from "../log.ts";

const log = logger("vaults");

export { DEFAULT_VAULT_ID };

// Mirrors the CHECK in 0004_vaults.sql. Re-checked here because the slug is
// joined into filesystem paths.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface VaultRow {
  id: number;
  slug: string;
  name: string;
}

export interface VaultInstance extends VaultRow {
  /** Process config with this vault's directories; sync and the ob CLI read paths from it. */
  config: Config;
  ctx: VaultContext;
  settings: VaultSettings;
  sync?: SyncSupervisor;
}

/** Path of a vault's MCP endpoint; the default vault keeps its original /mcp. */
export function mcpPath(vault: VaultRow): string {
  return vault.id === DEFAULT_VAULT_ID ? "/mcp" : `/v/${vault.slug}/mcp`;
}

export function listVaultRows(db: Database): VaultRow[] {
  return db.query<VaultRow, []>("SELECT id, slug, name FROM vaults ORDER BY id").all();
}

/**
 * The default vault predates multi-vault support and keeps the configured
 * VAULT_DIR / SNAPSHOTS_DIR / OB_CONFIG_DIR, so existing data and the ob sync
 * link (recorded against the vault path) stay where they are. Every other
 * vault lives under DATA_DIR/vaults/<slug>/ with its own ob config, which also
 * gives it its own sync login and lockfile.
 */
export function vaultConfig(config: Config, row: VaultRow): Config {
  if (row.id === DEFAULT_VAULT_ID) return config;
  if (!SLUG_RE.test(row.slug)) throw new Error(`Invalid vault slug '${row.slug}'`);
  const root = join(config.dataDir, "vaults", row.slug);
  return {
    ...config,
    vaultDir: join(root, "Vault"),
    snapshotsDir: join(root, "snapshots"),
    obConfigDir: join(root, "obsidian-headless"),
  };
}

export class VaultRegistry {
  private readonly bySlug = new Map<string, VaultInstance>();

  constructor(instances: VaultInstance[]) {
    for (const v of instances) this.bySlug.set(v.slug, v);
    if (!instances.some((v) => v.id === DEFAULT_VAULT_ID)) throw new Error("VaultRegistry requires the default vault");
  }

  /** Open every vault in the database: directories, snapshots, and sync supervision. */
  static async boot(config: Config, db: Database): Promise<VaultRegistry> {
    const instances: VaultInstance[] = [];
    for (const row of listVaultRows(db)) {
      const vc = vaultConfig(config, row);
      for (const dir of [vc.vaultDir, vc.obConfigDir, vc.snapshotsDir]) mkdirSync(dir, { recursive: true });

      const store = new VaultStore(vc.vaultDir);
      const snapshotter = new Snapshotter(vc.snapshotsDir, vc.vaultDir, {
        debounceMs: vc.snapshotDebounceMs,
        maxWaitMs: vc.snapshotMaxWaitMs,
        intervalMs: vc.snapshotIntervalMs,
      });
      await snapshotter.init();
      snapshotter.startTimers();

      const settings = vaultSettings(db, row.id);
      const ctx = createVaultContext({
        store,
        links: new LinkIndex(store),
        snapshotter,
        vaultName: row.id === DEFAULT_VAULT_ID ? basename(vc.vaultDir) : row.name,
        ownerGuidance: () => settings.get("vault_instructions"),
      });

      const sync = new SyncSupervisor(vc, settings);
      snapshotter.setMutationListener(() => sync.noteLocalChange());
      sync.autostart();

      instances.push({ ...row, config: vc, ctx, settings, sync });
      log.info(`opened vault '${row.slug}' at ${vc.vaultDir}`);
    }
    return new VaultRegistry(instances);
  }

  default(): VaultInstance {
    return this.all().find((v) => v.id === DEFAULT_VAULT_ID)!;
  }

  get(slug: string): VaultInstance | undefined {
    return this.bySlug.get(slug);
  }

  all(): VaultInstance[] {
    return [...this.bySlug.values()];
  }

  /** Stop sync first so ob can't write mid-commit, then take each final snapshot. */
  async shutdown(): Promise<void> {
    await Promise.all(this.all().map((v) => v.sync?.shutdown()));
    await Promise.all(this.all().map((v) => v.ctx.snapshotter.shutdown()));
  }
}
