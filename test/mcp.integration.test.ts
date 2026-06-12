import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { VaultStore } from "../src/vault/store.ts";
import { LinkIndex } from "../src/vault/links.ts";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { createVaultContext } from "../src/mcp/context.ts";
import { createApiToken } from "../src/auth/tokens.ts";
import { fixtureVault, type TmpVault } from "./helpers.ts";

let vault: TmpVault;
let snapsDir: string;
let server: ReturnType<typeof Bun.serve>;
let client: Client;
let snapshotter: Snapshotter;

function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

function jsonOf(result: CallToolResult): any {
  return JSON.parse(textOf(result));
}

beforeAll(async () => {
  vault = fixtureVault();
  snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
  const db = openDatabase(":memory:");
  const store = new VaultStore(vault.dir);
  const links = new LinkIndex(store);
  snapshotter = new Snapshotter(snapsDir, vault.dir, { debounceMs: 50, maxWaitMs: 500, intervalMs: 600_000 });
  await snapshotter.init();
  const vaultCtx = createVaultContext({
    store,
    links,
    snapshotter,
    vaultName: "TestVault",
    now: () => new Date(2026, 5, 12, 14, 30), // fixed: 2026-06-12
  });
  const config = loadConfig({ DATA_DIR: vault.dir } as unknown as NodeJS.ProcessEnv);
  const app = createApp({ config, db, vaultCtx, setupState: { token: null, pendingUserHandle: null } });
  server = Bun.serve({ port: 0, fetch: app.fetch });

  const { token } = createApiToken(db, "integration-test");
  client = new Client({ name: "test-client", version: "0.0.0" });
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

describe("MCP integration", () => {
  test("lists all 10 tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "browse_vault",
      "create_note",
      "daily_note",
      "edit_note",
      "get_links",
      "list_tags",
      "manage_note",
      "read_note",
      "search_vault",
      "vault_info",
    ]);
    const read = tools.find((t) => t.name === "read_note")!;
    expect(read.annotations?.readOnlyHint).toBe(true);
    const edit = tools.find((t) => t.name === "edit_note")!;
    expect(edit.annotations?.destructiveHint).toBe(true);
  });

  test("vault_info reports config and counts", async () => {
    const r = jsonOf((await client.callTool({ name: "vault_info", arguments: {} })) as CallToolResult);
    expect(r.counts.notes).toBeGreaterThanOrEqual(5);
    expect(r.daily_notes.folder).toBe("Journal");
    expect(r.daily_notes.today_path).toBe("Journal/2026-06-12.md");
    expect(r.templates.names).toContain("Daily");
    expect(r.link_format).toBe("shortest");
  });

  test("search_vault finds and highlights", async () => {
    const r = jsonOf((await client.callTool({ name: "search_vault", arguments: { query: "proxmox" } })) as CallToolResult);
    const lab = r.results.find((n: any) => n.path === "Projects/Home Lab.md");
    expect(lab.matches[0].text).toContain("«proxmox»");
  });

  test("read_note resolves wikilink targets and returns hash", async () => {
    const r = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Home Lab" } })) as CallToolResult);
    expect(r.path).toBe("Projects/Home Lab.md");
    expect(r.hash).toHaveLength(12);
    expect(r.frontmatter.status).toBe("active");
    expect(r.body).toContain("# Home Lab");
  });

  test("read_note missing gives suggestions", async () => {
    const result = (await client.callTool({ name: "read_note", arguments: { path: "Home Labb" } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Did you mean");
  });

  test("read_note outline + section modes", async () => {
    const outline = jsonOf(
      (await client.callTool({ name: "read_note", arguments: { path: "Home Lab", mode: "outline" } })) as CallToolResult,
    );
    expect(outline.outline.map((h: any) => h.text)).toEqual(["Home Lab", "Tasks", "Log"]);
    const section = jsonOf(
      (await client.callTool({
        name: "read_note",
        arguments: { path: "Home Lab", mode: "section", heading: "Tasks" },
      })) as CallToolResult,
    );
    expect(section.section.body).toContain("order switch");
  });

  test("edit_note stale hash → teaching error → retry succeeds", async () => {
    const read = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Inbox" } })) as CallToolResult);
    // simulate the sync daemon
    vault.write("Inbox.md", "Quick captures.\n\nExternal change!\n");
    const stale = (await client.callTool({
      name: "edit_note",
      arguments: {
        path: "Inbox",
        expected_hash: read.hash,
        edits: [{ type: "append", content: "- new item" }],
      },
    })) as CallToolResult;
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("STALE_NOTE");
    expect(textOf(stale)).toContain("read_note");

    const reread = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Inbox" } })) as CallToolResult);
    const okRes = jsonOf(
      (await client.callTool({
        name: "edit_note",
        arguments: {
          path: "Inbox",
          expected_hash: reread.hash,
          edits: [{ type: "append", content: "- new item" }],
        },
      })) as CallToolResult,
    );
    expect(okRes.edits_applied).toBe(1);
    expect(okRes.hash).not.toBe(reread.hash);
  });

  test("edit_note replace requires unique match", async () => {
    vault.write("Dup.md", "alpha\nalpha\n");
    const ambiguous = (await client.callTool({
      name: "edit_note",
      arguments: { path: "Dup", edits: [{ type: "replace", old_text: "alpha", new_text: "beta" }] },
    })) as CallToolResult;
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("AMBIGUOUS_MATCH");

    const fixed = jsonOf(
      (await client.callTool({
        name: "edit_note",
        arguments: { path: "Dup", edits: [{ type: "replace", old_text: "alpha", new_text: "beta", occurrence: 2 }] },
      })) as CallToolResult,
    );
    expect(fixed.edits_applied).toBe(1);
  });

  test("edit_note replace_content without hash is rejected", async () => {
    const r = (await client.callTool({
      name: "edit_note",
      arguments: { path: "Dup", edits: [{ type: "replace_content", content: "x" }] },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("expected_hash");
  });

  test("edit_note set_frontmatter preserves body", async () => {
    const r = jsonOf(
      (await client.callTool({
        name: "edit_note",
        arguments: { path: "Home Lab", edits: [{ type: "set_frontmatter", set: { status: "done" } }] },
      })) as CallToolResult,
    );
    expect(r.edits_applied).toBe(1);
    const read = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Home Lab" } })) as CallToolResult);
    expect(read.frontmatter.status).toBe("done");
    expect(read.frontmatter.tags).toEqual(["project", "infra"]);
    expect(read.body).toContain("# Home Lab");
  });

  test("create_note with template and unique collision", async () => {
    const r = jsonOf(
      (await client.callTool({
        name: "create_note",
        arguments: { path: "Meetings/Standup", template: "Daily", frontmatter: { tags: ["meeting"] } },
      })) as CallToolResult,
    );
    expect(r.created).toBe(true);
    const read = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Meetings/Standup" } })) as CallToolResult);
    expect(read.body).toContain("# 2026-06-12"); // {{date}} substituted
    expect(read.frontmatter.tags).toEqual(["meeting"]);

    const dup = (await client.callTool({
      name: "create_note",
      arguments: { path: "Meetings/Standup" },
    })) as CallToolResult;
    expect(dup.isError).toBe(true);
    expect(textOf(dup)).toContain("if_exists");

    const unique = jsonOf(
      (await client.callTool({
        name: "create_note",
        arguments: { path: "Meetings/Standup", if_exists: "unique" },
      })) as CallToolResult,
    );
    expect(unique.path).toBe("Meetings/Standup 1.md");
  });

  test("daily_note append creates from template and targets heading", async () => {
    const r = jsonOf(
      (await client.callTool({
        name: "daily_note",
        arguments: { action: "append", content: "- 14:30 shipped the release", heading: "Log" },
      })) as CallToolResult,
    );
    expect(r.path).toBe("Journal/2026-06-12.md");
    expect(r.created).toBe(true);
    expect(r.appended).toBe(true);
    const read = jsonOf(
      (await client.callTool({ name: "daily_note", arguments: { action: "read" } })) as CallToolResult,
    );
    const logIdx = read.body.indexOf("## Log");
    const notesIdx = read.body.indexOf("## Notes");
    const entryIdx = read.body.indexOf("- 14:30 shipped the release");
    expect(entryIdx).toBeGreaterThan(logIdx);
    expect(entryIdx).toBeLessThan(notesIdx); // landed inside the Log section
  });

  test("get_links returns backlinks with context and unresolved", async () => {
    const r = jsonOf((await client.callTool({ name: "get_links", arguments: { path: "Home Lab" } })) as CallToolResult);
    const sources = r.backlinks.map((b: any) => b.source);
    expect(sources).toContain("Journal/2026-06-10.md");
    expect(r.backlinks.find((b: any) => b.source === "Journal/2026-06-10.md").context).toContain("[[Home Lab]]");
    expect(r.embeds.map((e: any) => e.target)).toContain("Attachments/rack.png");
  });

  test("list_tags merges inline and frontmatter tags", async () => {
    const r = jsonOf((await client.callTool({ name: "list_tags", arguments: {} })) as CallToolResult);
    const tags = Object.fromEntries(r.tags.map((t: any) => [t.tag, t.count]));
    expect(tags.infra).toBe(2);
    expect(tags.journal).toBe(1);
  });

  test("manage_note move rewrites backlinks", async () => {
    const r = jsonOf(
      (await client.callTool({
        name: "manage_note",
        arguments: { action: "move", path: "Reference/Proxmox.md", destination: "Archive/Proxmox Notes" },
      })) as CallToolResult,
    );
    expect(r.destination).toBe("Archive/Proxmox Notes.md");
    expect(r.links_updated.files).toContain("Projects/Home Lab.md");
    const lab = jsonOf((await client.callTool({ name: "read_note", arguments: { path: "Home Lab" } })) as CallToolResult);
    expect(lab.body).toContain("[[Proxmox Notes]]");
    expect(lab.body).not.toContain("[[Proxmox]] ");
  });

  test("manage_note delete goes to .trash and is browsable", async () => {
    const r = jsonOf(
      (await client.callTool({ name: "manage_note", arguments: { action: "delete", path: "Dup" } })) as CallToolResult,
    );
    expect(r.trashed_to).toBe(".trash/Dup.md");
    const browse = jsonOf(
      (await client.callTool({ name: "browse_vault", arguments: { path: ".trash" } })) as CallToolResult,
    );
    expect(browse.entries.map((e: any) => e.name)).toContain("Dup.md");
  });

  test("browse_vault tree mode renders compactly", async () => {
    const r = (await client.callTool({ name: "browse_vault", arguments: { format: "tree" } })) as CallToolResult;
    const text = textOf(r);
    expect(text).toContain("Projects/");
    expect(text).toContain("Home Lab.md");
    expect(text).not.toContain(".obsidian");
  });

  test("protected paths rejected with PROTECTED_PATH", async () => {
    const r = (await client.callTool({
      name: "create_note",
      arguments: { path: ".obsidian/evil" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("PROTECTED_PATH");
  });

  test("mutations produced git snapshots", async () => {
    await snapshotter.flush();
    const commits = await snapshotter.listCommits(100);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits.some((c) => c.message.startsWith("pre-op: move"))).toBe(true);
  });

  test("resources: vault root and note template", async () => {
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "vault:///")).toBe(true);
    const note = await client.readResource({ uri: "vault:///Inbox.md" });
    const c = note.contents[0]!;
    expect(c.mimeType).toBe("text/markdown");
    expect(String("text" in c ? c.text : "")).toContain("Quick captures");
  });

  test("prompts registered", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["daily_review", "inbox_note"]);
    const p = await client.getPrompt({ name: "inbox_note", arguments: { thought: "buy milk" } });
    expect(JSON.stringify(p.messages)).toContain("buy milk");
  });
});
