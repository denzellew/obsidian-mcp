import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.ts";
import { DEFAULT_VAULT_ID, vaultSettings, type VaultSettings } from "../db/index.ts";
import { abortRegistry } from "../auth/tokens.ts";
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

/** The name 0004_vaults.sql gives the pre-existing vault. */
const DEFAULT_VAULT_NAME = "Vault";

/** A vault change the owner can fix (bad slug, taken slug); the message is shown as-is. */
export class VaultError extends Error {}

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

async function openVault(config: Config, db: Database, row: VaultRow): Promise<VaultInstance> {
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
    // until renamed, the default vault keeps reporting its folder name as before
    vaultName: row.id === DEFAULT_VAULT_ID && row.name === DEFAULT_VAULT_NAME ? basename(vc.vaultDir) : row.name,
    ownerGuidance: () => settings.get("vault_instructions"),
  });

  const sync = new SyncSupervisor(vc, settings);
  snapshotter.setMutationListener(() => sync.noteLocalChange());
  sync.autostart();

  log.info(`opened vault '${row.slug}' at ${vc.vaultDir}`);
  return { ...row, config: vc, ctx, settings, sync };
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
    for (const row of listVaultRows(db)) instances.push(await openVault(config, db, row));
    return new VaultRegistry(instances);
  }

  /**
   * Add a vault and start serving it. Its folders live under
   * DATA_DIR/vaults/<slug>/; if they survive from a removed vault of the same
   * slug, their notes, snapshots, and ob login are picked up again.
   */
  async create(config: Config, db: Database, input: { slug: string; name: string }): Promise<VaultInstance> {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new VaultError("Name is required.");
    if (!SLUG_RE.test(slug)) {
      throw new VaultError("Slug must be 1–40 lowercase letters, digits, or hyphens, and can't start or end with a hyphen.");
    }
    if (this.bySlug.has(slug)) throw new VaultError(`A vault with slug '${slug}' already exists.`);
    const id = Number(db.query("INSERT INTO vaults (slug, name) VALUES (?, ?)").run(slug, name).lastInsertRowid);
    let vault: VaultInstance;
    try {
      vault = await openVault(config, db, { id, slug, name });
    } catch (err) {
      db.query("DELETE FROM vaults WHERE id = ?").run(id);
      throw err;
    }
    this.bySlug.set(slug, vault);
    return vault;
  }

  rename(db: Database, slug: string, name: string): VaultInstance {
    const vault = this.bySlug.get(slug);
    if (!vault) throw new VaultError(`No vault '${slug}'.`);
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw new VaultError("Name is required.");
    db.query("UPDATE vaults SET name = ? WHERE id = ?").run(trimmed, vault.id);
    vault.name = trimmed;
    vault.ctx.vaultName = trimmed;
    return vault;
  }

  /**
   * Stop serving a vault and revoke every credential bound to it. Files on
   * disk are left alone: removing a vault from the portal must never be the
   * thing that loses notes.
   */
  async remove(db: Database, slug: string): Promise<VaultInstance> {
    const vault = this.bySlug.get(slug);
    if (!vault) throw new VaultError(`No vault '${slug}'.`);
    if (vault.id === DEFAULT_VAULT_ID) throw new VaultError("The default vault can't be removed.");
    // unlisted first, so no new request resolves it while we shut it down
    this.bySlug.delete(slug);
    await vault.sync?.shutdown();
    await vault.ctx.snapshotter.shutdown();

    const hashes = db
      .query<{ h: string }, [number, number]>(
        "SELECT token_hash AS h FROM api_tokens WHERE vault_id = ? AND revoked_at IS NULL " +
          "UNION ALL SELECT access_token_hash FROM oauth_grants WHERE vault_id = ? AND revoked_at IS NULL",
      )
      .all(vault.id, vault.id);
    const clients = db
      .query<{ client_id: string }, [number]>("SELECT client_id FROM oauth_consents WHERE vault_id = ?")
      .all(vault.id);
    db.transaction(() => {
      // no FK on these vault_id columns (see 0005), so they are cleared by hand
      db.query("DELETE FROM api_tokens WHERE vault_id = ?").run(vault.id);
      db.query("DELETE FROM oauth_grants WHERE vault_id = ?").run(vault.id);
      db.query("DELETE FROM oauth_authorization_codes WHERE vault_id = ?").run(vault.id);
      db.query("DELETE FROM vaults WHERE id = ?").run(vault.id); // cascades settings and consents
      // as with revoking a connection, a client no vault approves any more is forgotten
      for (const { client_id } of clients) {
        db.query("DELETE FROM oauth_clients WHERE client_id = ? AND NOT EXISTS (SELECT 1 FROM oauth_consents WHERE client_id = ?)").run(
          client_id,
          client_id,
        );
      }
    })();
    for (const { h } of hashes) abortRegistry.abort(h);
    log.info(`removed vault '${slug}' (files kept at ${vault.config.vaultDir})`);
    return vault;
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
