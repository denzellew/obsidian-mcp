import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "./context.ts";
import { registerVaultInfo } from "./tools/vault-info.ts";
import { registerBrowseVault } from "./tools/browse-vault.ts";
import { registerSearchVault } from "./tools/search-vault.ts";
import { registerReadNote } from "./tools/read-note.ts";
import { registerCreateNote } from "./tools/create-note.ts";
import { registerEditNote } from "./tools/edit-note.ts";
import { registerManageNote } from "./tools/manage-note.ts";
import { registerGetLinks } from "./tools/get-links.ts";
import { registerListTags } from "./tools/list-tags.ts";
import { registerDailyNote } from "./tools/daily-note.ts";
import { registerResources } from "./resources.ts";
import { registerPrompts } from "./prompts.ts";

export const SERVER_INSTRUCTIONS = `Obsidian vault server. The vault may be edited concurrently by the user's other devices (Obsidian Sync), so:
- ALWAYS read_note before editing and pass its hash as expected_hash; on STALE_NOTE errors, re-read and retry.
- Prefer surgical edits (replace/append) over whole-content replacement.
- Call vault_info first in a session to learn the vault's structure, daily-note settings, and templates.
- Paths are vault-relative; wikilink targets like "Note Name" are accepted wherever a path is expected.
- Deletions go to .trash/ and every mutation is git-snapshotted — mistakes are recoverable, but say what you changed.`;

export function createMcpServer(ctx: VaultContext): McpServer {
  const server = new McpServer(
    { name: "obsidian-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerVaultInfo(server, ctx);
  registerBrowseVault(server, ctx);
  registerSearchVault(server, ctx);
  registerReadNote(server, ctx);
  registerCreateNote(server, ctx);
  registerEditNote(server, ctx);
  registerManageNote(server, ctx);
  registerGetLinks(server, ctx);
  registerListTags(server, ctx);
  registerDailyNote(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
