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
import { categorize, summarize, listAudit } from "../src/mcp/audit.ts";
import { createApiToken } from "../src/auth/tokens.ts";
import { fixtureVault, type TmpVault } from "./helpers.ts";
import type { Database } from "bun:sqlite";

describe("audit categorize/summarize", () => {
  test("categories by tool and action", () => {
    expect(categorize("read_note", "read_note")).toBe("read");
    expect(categorize("create_note", "create_note")).toBe("create");
    expect(categorize("edit_note", "edit:append")).toBe("edit");
    expect(categorize("manage_note", "manage_note:delete")).toBe("delete");
    expect(categorize("manage_note", "manage_note:move")).toBe("move");
    expect(categorize("daily_note", "daily_note:append")).toBe("daily");
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
  function ctx(guidance: string | null) {
    return { ownerGuidance: () => guidance } as Parameters<typeof buildInstructions>[0];
  }
  test("base only when no guidance", () => {
    const out = buildInstructions(ctx(null));
    expect(out).toContain("Obsidian vault server");
    expect(out).not.toContain("Vault-specific guidance");
  });
  test("appends owner guidance", () => {
    const out = buildInstructions(ctx("Weekly notes live in Journal/Weekly."));
    expect(out).toContain("Vault-specific guidance from the owner");
    expect(out).toContain("Weekly notes live in Journal/Weekly.");
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
    const byTool = (t: string) => all.find((e) => e.tool === t)!;

    expect(byTool("search_vault")).toMatchObject({ actor_name: "Claude Code on laptop", target: "proxmox", status: "ok" });
    expect(byTool("create_note")).toMatchObject({ action: "create_note", target: "Audit/Test", status: "ok" });

    const failedRead = all.find((e) => e.tool === "read_note" && e.status === "error")!;
    expect(failedRead).toBeDefined();
    expect(failedRead.detail).toContain("NOT_FOUND");

    // writes-only filter excludes the reads/searches
    const writes = listAudit(db, { limit: 100, writesOnly: true });
    expect(writes.some((e) => e.tool === "create_note")).toBe(true);
    expect(writes.some((e) => e.tool === "search_vault")).toBe(false);
  });

  test("audit page renders with badges", async () => {
    // seed a session and hit the page through the app
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    const { createSession } = await import("../src/auth/sessions.ts");
    const { SESSION_COOKIE } = await import("../src/auth/middleware.ts");
    const cookie = `${SESSION_COOKIE}=${createSession(db, 1)}`;
    const res = await fetch(`http://localhost:${server.port}/app/audit`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("MCP activity");
    expect(html).toContain("create_note");
  });
});
