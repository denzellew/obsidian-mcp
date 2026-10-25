import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.tsx";
import { createApiToken } from "../src/auth/tokens.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { createVaultContext } from "../src/mcp/context.ts";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { LinkIndex } from "../src/vault/links.ts";
import { VaultStore } from "../src/vault/store.ts";
import { tmpVault, type TmpVault } from "./helpers.ts";

let vault: TmpVault;
let snapshots: string;
let server: ReturnType<typeof Bun.serve>;
let general: Client;
let privateClient: Client;
let owner: Client;

function json(result: CallToolResult): any {
  const content = result.content.find((block) => block.type === "text");
  return JSON.parse(content && content.type === "text" ? content.text : "");
}

function client(port: number, token: string) {
  const next = new Client({ name: "personal-context-test", version: "0.0.0" });
  return next.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  ).then(() => next);
}

beforeAll(async () => {
  vault = tmpVault({
    "Profile.md": "---\ncategory: identity\nsensitivity: general\nconfidence: explicit\nstatus: active\nupdated: 2026-10-24\nsummary: Engineering background\n---\n# Profile\n\nSenior engineer.\n",
    "Finances.md": "---\ncategory: finances\nsensitivity: private\nconfidence: explicit\nstatus: active\nupdated: 2026-10-24\nsummary: Financial preferences\n---\n# Finances\n\nPrivate financial context.\n",
  });
  snapshots = mkdtempSync(join(tmpdir(), "personal-context-snaps-"));
  const db = openDatabase(":memory:");
  const store = new VaultStore(vault.dir);
  const snapshotter = new Snapshotter(snapshots, vault.dir, { debounceMs: 10, maxWaitMs: 100, intervalMs: 600_000 });
  await snapshotter.init();
  const context = createVaultContext({ store, links: new LinkIndex(store), snapshotter, now: () => new Date("2026-10-24T10:00:00Z") });
  const config = loadConfig({ DATA_DIR: vault.dir, PUBLIC_URL: "http://localhost:3000", MCP_PROFILE: "personal-context" } as NodeJS.ProcessEnv);
  const generalToken = createApiToken(db, "general").token;
  const privateToken = createApiToken(db, "private").token;
  const ownerToken = createApiToken(db, "owner").token;
  const tokens = db.query<{ id: string; name: string }, []>("SELECT id, name FROM api_tokens").all();
  for (const token of tokens) {
    if (token.name === "private") {
      db.query("INSERT INTO personal_client_policies VALUES ('static', ?, '[\"general\",\"private\"]', '[\"*\"]', '[\"read\",\"propose\"]')").run(token.id);
    }
    if (token.name === "owner") {
      db.query("INSERT INTO personal_client_policies VALUES ('static', ?, '[\"general\",\"private\",\"restricted\"]', '[\"*\"]', '[\"read\",\"propose\",\"approve\"]')").run(token.id);
    }
  }
  server = Bun.serve({ port: 0, fetch: createApp({ config, db, vaultCtx: context, setupState: { token: null, pendingUserHandle: null } }).fetch });
  const port = server.port!;
  general = await client(port, generalToken);
  privateClient = await client(port, privateToken);
  owner = await client(port, ownerToken);
});

afterAll(async () => {
  await general?.close();
  await privateClient?.close();
  await owner?.close();
  server?.stop(true);
  vault?.cleanup();
  rmSync(snapshots, { recursive: true, force: true });
});

describe("Personal Context MCP", () => {
  test("exposes only the restricted personal API", async () => {
    const { tools } = await general.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "approve_personal_update",
      "get_personal_context",
      "get_personal_profile",
      "propose_personal_update",
      "search_personal_context",
    ]);
  });

  test("filters private context for the default general policy", async () => {
    const result = json((await general.callTool({ name: "search_personal_context", arguments: { query: "engineer" } })) as CallToolResult);
    expect(result.results.map((note: any) => note.path)).toEqual(["Profile.md"]);
    const forbidden = (await general.callTool({ name: "get_personal_context", arguments: { category: "finances" } })) as CallToolResult;
    expect(forbidden.isError).toBe(true);
  });

  test("allows explicitly assigned private context", async () => {
    const result = json((await privateClient.callTool({ name: "get_personal_context", arguments: { category: "finances" } })) as CallToolResult);
    expect(result.notes[0].body).toContain("Private financial context");
  });

  test("promotes only an owner-approved proposal with its expected hash", async () => {
    const profile = json((await owner.callTool({ name: "get_personal_profile", arguments: {} })) as CallToolResult);
    const proposal = json(
      (await privateClient.callTool({
        name: "propose_personal_update",
        arguments: {
          target_path: "Profile.md",
          expected_hash: profile.hash,
          category: "identity",
          sensitivity: "general",
          content: "---\ncategory: identity\nsensitivity: general\nconfidence: explicit\nstatus: active\nupdated: 2026-10-24\n---\n# Profile\n\nUpdated profile.\n",
          evidence: "Owner correction",
          scope: "Profile summary",
        },
      })) as CallToolResult,
    );
    const rejected = (await privateClient.callTool({ name: "approve_personal_update", arguments: { proposal_id: proposal.proposal_id } })) as CallToolResult;
    expect(rejected.isError).toBe(true);
    const approved = json((await owner.callTool({ name: "approve_personal_update", arguments: { proposal_id: proposal.proposal_id } })) as CallToolResult);
    expect(approved.status).toBe("approved");
    const updated = json((await owner.callTool({ name: "get_personal_profile", arguments: {} })) as CallToolResult);
    expect(updated.body).toContain("Updated profile");
  });
});
