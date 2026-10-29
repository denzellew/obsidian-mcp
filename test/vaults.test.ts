import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDatabase, setSetting, vaultSettings } from "../src/db/index.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { DEFAULT_VAULT_ID, VaultRegistry, vaultConfig } from "../src/vaults/registry.ts";

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
    const path = join(dir, "app.db");
    const pre = new Database(path, { create: true });
    pre.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
    for (const file of ["0001_init.sql", "0002_audit.sql", "0003_audit_unify.sql"]) {
      pre.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      pre.query("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    }
    setSetting(pre, "vault_instructions", "Use Inbox.md");
    setSetting(pre, "sync_configured", "1");
    setSetting(pre, "sync_desired", "1");
    setSetting(pre, "rp_id_at_setup", "knowledge.example.com");
    pre.close();

    const db = openDatabase(path);
    const settings = vaultSettings(db, DEFAULT_VAULT_ID);
    expect(settings.get("vault_instructions")).toBe("Use Inbox.md");
    expect(settings.get("sync_configured")).toBe("1");
    expect(settings.get("sync_desired")).toBe("1");
    expect(getSetting(db, "vault_instructions")).toBeNull();
    expect(getSetting(db, "rp_id_at_setup")).toBe("knowledge.example.com");
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
  test("default vault keeps configured dirs; others live under vaults/<slug>", () => {
    expect(vaultConfig(config, { id: DEFAULT_VAULT_ID, slug: "default", name: "Vault" })).toBe(config);
    const personal = vaultConfig(config, { id: 2, slug: "personal", name: "Personal" });
    expect(personal.vaultDir).toBe(join(dir, "vaults", "personal", "Vault"));
    expect(personal.snapshotsDir).toBe(join(dir, "vaults", "personal", "snapshots"));
    expect(personal.obConfigDir).toBe(join(dir, "vaults", "personal", "obsidian-headless"));
    expect(() => vaultConfig(config, { id: 3, slug: "../x", name: "x" })).toThrow();
  });

  test("boots every vault with isolated dirs, settings, and guidance", async () => {
    const db = openDatabase(":memory:");
    db.query("INSERT INTO vaults (slug, name) VALUES ('personal', 'Personal')").run();
    const registry = await VaultRegistry.boot(config, db);
    try {
      const def = registry.default();
      const personal = registry.get("personal")!;
      expect(registry.all().map((v) => v.slug)).toEqual(["default", "personal"]);
      expect(def.ctx.store.vaultDir).toBe(config.vaultDir);
      expect(personal.ctx.store.vaultDir).toBe(join(dir, "vaults", "personal", "Vault"));
      expect(existsSync(join(dir, "vaults", "personal", "snapshots", "vault.git"))).toBe(true);
      expect(def.ctx.vaultName).toBe("Vault");
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

  test("requires the default vault", () => {
    expect(() => new VaultRegistry([])).toThrow();
  });
});
