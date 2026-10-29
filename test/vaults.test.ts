import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDatabase, setSetting, vaultSettings } from "../src/db/index.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { VaultRegistry, listVaultRows, vaultConfig } from "../src/vaults/registry.ts";

const MIGRATIONS = join(import.meta.dir, "..", "src", "db", "migrations");

let dir: string;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obmcp-vaults-"));
  config = { ...loadConfig({ DATA_DIR: dir } as unknown as NodeJS.ProcessEnv), syncAutostart: false, obBin: "/nonexistent/ob" };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("0004_vaults migration", () => {
  test("moves per-vault settings onto vault 1 and leaves global ones", () => {
    // applied by hand, only through 0004: 0006 drops vault 1 again
    const db = new Database(":memory:");
    const apply = (file: string) => db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    for (const file of ["0001_init.sql", "0002_audit.sql", "0003_audit_unify.sql"]) apply(file);
    setSetting(db, "vault_instructions", "Use Inbox.md");
    setSetting(db, "sync_configured", "1");
    setSetting(db, "sync_desired", "1");
    setSetting(db, "rp_id_at_setup", "knowledge.example.com");
    apply("0004_vaults.sql");

    const settings = vaultSettings(db, 1);
    expect(settings.get("vault_instructions")).toBe("Use Inbox.md");
    expect(settings.get("sync_configured")).toBe("1");
    expect(settings.get("sync_desired")).toBe("1");
    expect(getSetting(db, "vault_instructions")).toBeNull();
    expect(getSetting(db, "rp_id_at_setup")).toBe("knowledge.example.com");
    db.close();
  });
});

describe("0006_no_default_vault migration", () => {
  test("a fresh install starts with no vaults", () => {
    expect(listVaultRows(openDatabase(":memory:"))).toEqual([]);
  });

  test("an older install's vault is dropped with its credentials", () => {
    const path = join(dir, "app.db");
    const pre = new Database(path, { create: true });
    pre.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
    for (const file of ["0001_init.sql", "0002_audit.sql", "0003_audit_unify.sql", "0004_vaults.sql", "0005_vault_bound_auth.sql"]) {
      pre.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      pre.query("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    }
    pre.query("INSERT INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    pre.query("INSERT INTO api_tokens (id, name, token_prefix, token_hash) VALUES ('t1', 'old', 'obmcp_x', 'h')").run();
    vaultSettings(pre, 1).set("vault_instructions", "old");
    pre.close();

    const db = openDatabase(path);
    expect(listVaultRows(db)).toEqual([]);
    expect(db.query("SELECT 1 FROM api_tokens").get()).toBeNull();
    expect(db.query("SELECT 1 FROM vault_settings").get()).toBeNull();
    expect(db.query("SELECT 1 FROM users").get()).not.toBeNull();
    db.close();
  });

  test("rejects slugs that are unsafe as path segments", () => {
    const db = openDatabase(":memory:");
    const insert = (slug: string) => db.query("INSERT INTO vaults (slug, name) VALUES (?, 'x')").run(slug);
    for (const bad of ["", "../etc", "Personal", "a/b", "-x", "x-", "a".repeat(41)]) {
      expect(() => insert(bad)).toThrow();
    }
    expect(() => insert("personal-context")).not.toThrow();
  });
});

describe("VaultRegistry", () => {
  test("vaults live under vaults/<slug>", () => {
    const personal = vaultConfig(config, { id: 2, slug: "personal", name: "Personal" });
    expect(personal.vaultDir).toBe(join(dir, "vaults", "personal", "Vault"));
    expect(personal.snapshotsDir).toBe(join(dir, "vaults", "personal", "snapshots"));
    expect(personal.obConfigDir).toBe(join(dir, "vaults", "personal", "obsidian-headless"));
    expect(() => vaultConfig(config, { id: 3, slug: "../x", name: "x" })).toThrow();
  });

  test("boots every vault with isolated dirs, settings, and guidance", async () => {
    const db = openDatabase(":memory:");
    db.query("INSERT INTO vaults (slug, name) VALUES ('knowledge', 'Knowledge'), ('personal', 'Personal')").run();
    const registry = await VaultRegistry.boot(config, db);
    try {
      const def = registry.get("knowledge")!;
      const personal = registry.get("personal")!;
      expect(registry.all().map((v) => v.slug)).toEqual(["knowledge", "personal"]);
      expect(def.ctx.store.vaultDir).toBe(join(dir, "vaults", "knowledge", "Vault"));
      expect(personal.ctx.store.vaultDir).toBe(join(dir, "vaults", "personal", "Vault"));
      expect(existsSync(join(dir, "vaults", "personal", "snapshots", "vault.git"))).toBe(true);
      expect(def.ctx.vaultName).toBe("Knowledge");
      expect(personal.ctx.vaultName).toBe("Personal");

      personal.settings.set("vault_instructions", "Personal only");
      expect(personal.ctx.ownerGuidance()).toBe("Personal only");
      expect(def.ctx.ownerGuidance()).toBeNull();

      personal.sync!.start();
      expect(personal.sync!.desiredRunning()).toBe(true);
      expect(def.sync!.desiredRunning()).toBe(false);
    } finally {
      await registry.shutdown();
      db.close();
    }
  });

  test("boots with no vaults", async () => {
    const registry = await VaultRegistry.boot(config, openDatabase(":memory:"));
    expect(registry.all()).toEqual([]);
    await registry.shutdown();
  });
});
