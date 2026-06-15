import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase, setSetting } from "../src/db/index.ts";
import { VaultStore } from "../src/vault/store.ts";
import { LinkIndex } from "../src/vault/links.ts";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { createVaultContext } from "../src/mcp/context.ts";
import { buildInstructions } from "../src/mcp/server.ts";
import { categorize, summarize, listAudit, recordAdmin } from "../src/audit.ts";
import { createApiToken } from "../src/auth/tokens.ts";
import { fixtureVault, type TmpVault } from "./helpers.ts";
import type { Database } from "bun:sqlite";

describe("audit categorize/summarize", () => {
  test("agent categories by tool and action", () => {
    expect(categorize("agent", "read_note", "read_note")).toBe("read");
    expect(categorize("agent", "create_note", "create_note")).toBe("create");
    expect(categorize("agent", "edit_note", "edit:append")).toBe("edit");
    expect(categorize("agent", "manage_note", "manage_note:delete")).toBe("delete");
    expect(categorize("agent", "manage_note", "manage_note:move")).toBe("move");
    expect(categorize("agent", "daily_note", "daily_note:append")).toBe("daily");
  });

  test("owner categories by event", () => {
    expect(categorize("security", "login", null)).toBe("session");
    expect(categorize("security", "passkey.add", null)).toBe("create");
    expect(categorize("security", "token.revoke", null)).toBe("delete");
    expect(categorize("security", "oauth.consent", null)).toBe("auth");
    expect(categorize("config", "sync.configure", null)).toBe("config");
    expect(categorize("config", "snapshot.restore", null)).toBe("edit");
  });

  test("summarize derives action + target", () => {
    expect(summarize("manage_note", { action: "move", path: "A.md", destination: "B.md" })).toEqual({
      action: "manage_note:move",
      target: "A.md → B.md",
    });
    expect(summarize("edit_note", { path: "N.md", edits: [{ type: "append" }, { type: "replace" }] })).toEqual({
      action: "edit:append+replace",
      target: "N.md",
    });
    expect(summarize("search_vault", { query: "kubernetes" })).toEqual({ action: "search_vault", target: "kubernetes" });
  });
});

describe("buildInstructions", () => {
  function ctx(guidance: string | null, vaultGuide: string | null = null) {
    return { ownerGuidance: () => guidance, vaultGuide: () => vaultGuide } as Parameters<typeof buildInstructions>[0];
  }
  test("base only when no guidance", () => {
    const out = buildInstructions(ctx(null));
    expect(out).toContain("Obsidian vault server");
    expect(out).not.toContain("Vault-specific guidance");
    expect(out).not.toContain("AGENTS.md");
  });
  test("appends owner guidance", () => {
    const out = buildInstructions(ctx("Weekly notes live in Journal/Weekly."));
    expect(out).toContain("Vault-specific guidance from the owner");
    expect(out).toContain("Weekly notes live in Journal/Weekly.");
  });
  test("folds in the vault's AGENTS.md", () => {
    const out = buildInstructions(ctx(null, "# Vault Guide\nUse the Dataview plugin for indexes."));
    expect(out).toContain("Vault guide (AGENTS.md)");
    expect(out).toContain("Use the Dataview plugin for indexes.");
  });
  test("includes both AGENTS.md and owner guidance", () => {
    const out = buildInstructions(ctx("Owner says hi.", "Vault guide says hi."));
    expect(out).toContain("Vault guide says hi.");
    expect(out).toContain("Owner says hi.");
  });
});

describe("audit + guidance end-to-end", () => {
  let vault: TmpVault;
  let snapsDir: string;
  let db: Database;
  let server: ReturnType<typeof Bun.serve>;
  let client: Client;

  beforeAll(async () => {
    vault = fixtureVault();
    snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
    db = openDatabase(":memory:");
    setSetting(db, "vault_instructions", "I use the Tasks plugin; open tasks are '- [ ]' lines.");
    const store = new VaultStore(vault.dir);
    const snapshotter = new Snapshotter(snapsDir, vault.dir, { debounceMs: 50, maxWaitMs: 500, intervalMs: 600_000 });
    await snapshotter.init();
    const vaultCtx = createVaultContext({
      store,
      links: new LinkIndex(store),
      snapshotter,
      now: () => new Date(2026, 5, 12, 14, 30),
      ownerGuidance: () => (require("../src/db/index.ts").getSetting(db, "vault_instructions") as string) ?? null,
    });
    const config = loadConfig({ DATA_DIR: vault.dir, PUBLIC_URL: "http://localhost:3000" } as unknown as NodeJS.ProcessEnv);
    const app = createApp({ config, db, vaultCtx, setupState: { token: null, pendingUserHandle: null } });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    const { token } = createApiToken(db, "Claude Code on laptop");
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    server?.stop(true);
    vault?.cleanup();
    rmSync(snapsDir, { recursive: true, force: true });
  });

  test("server initialize exposes owner guidance in instructions", () => {
    expect(client.getInstructions()).toContain("Tasks plugin");
  });

  test("vault_info returns owner_guidance", async () => {
    const r = JSON.parse(
      ((await client.callTool({ name: "vault_info", arguments: {} })) as CallToolResult).content.find((b) => b.type === "text")!
        .text as string,
    );
    expect(r.owner_guidance).toContain("Tasks plugin");
  });

  test("tool calls are recorded with actor, action, target, status", async () => {
    await client.callTool({ name: "search_vault", arguments: { query: "proxmox" } });
    await client.callTool({ name: "read_note", arguments: { path: "Inbox" } });
    await client.callTool({ name: "create_note", arguments: { path: "Audit/Test", content: "x" } });
    await client.callTool({ name: "read_note", arguments: { path: "DoesNotExist" } }); // error path

    const all = listAudit(db, { limit: 100 });
    const byTool = (t: string) => all.find((e) => e.event === t)!;

    expect(byTool("search_vault")).toMatchObject({ source: "agent", actor_name: "Claude Code on laptop", target: "proxmox", status: "ok" });
    expect(byTool("create_note")).toMatchObject({ action: "create_note", target: "Audit/Test", status: "ok" });

    const failedRead = all.find((e) => e.event === "read_note" && e.status === "error")!;
    expect(failedRead).toBeDefined();
    expect(failedRead.detail).toContain("NOT_FOUND");

    // agent-source filter shows tool calls, not owner actions
    const agent = listAudit(db, { limit: 100, source: "agent" });
    expect(agent.every((e) => e.source === "agent")).toBe(true);
    expect(agent.some((e) => e.event === "create_note")).toBe(true);
  });

  test("owner actions are recorded under security/config sources", () => {
    recordAdmin(db, "token.create", { target: "ci token" });
    recordAdmin(db, "login");
    recordAdmin(db, "sync.configure", { target: "My Vault" });

    const security = listAudit(db, { limit: 100, source: "security" });
    expect(security.find((e) => e.event === "token.create")).toMatchObject({ actor_name: "owner", target: "ci token" });
    expect(security.some((e) => e.event === "login")).toBe(true);
    // sync.* lands in config, not security
    expect(security.some((e) => e.event === "sync.configure")).toBe(false);

    const config = listAudit(db, { limit: 100, source: "config" });
    expect(config.find((e) => e.event === "sync.configure")).toMatchObject({ target: "My Vault" });
  });

  test("activity page renders with source tabs and badges", async () => {
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    const { createSession } = await import("../src/auth/sessions.ts");
    const { SESSION_COOKIE } = await import("../src/auth/middleware.ts");
    const cookie = `${SESSION_COOKIE}=${createSession(db, 1)}`;
    const res = await fetch(`http://localhost:${server.port}/app/audit`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Activity");
    expect(html).toContain("create_note");

    const sec = await fetch(`http://localhost:${server.port}/app/audit?tab=security`, { headers: { Cookie: cookie } });
    const secHtml = await sec.text();
    expect(secHtml).toContain("token.create");
  });
});
