import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "./context.ts";
import { registerVaultInfo } from "./tools/vault-info.ts";
import { registerVaultConfig } from "./tools/vault-config.ts";
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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthPrincipal } from "../auth/tokens.ts";
import type { Database } from "bun:sqlite";

export const SERVER_INSTRUCTIONS = `Obsidian vault server. The vault may be edited concurrently by the user's other devices (Obsidian Sync), so:
- ALWAYS read_note before editing and pass its hash as expected_hash; on STALE_NOTE errors, re-read and retry.
- Prefer surgical edits (replace/append) over whole-content replacement.
- Call vault_info first in a session to learn the vault's structure, daily-note settings, and templates.
- Paths are vault-relative; wikilink targets like "Note Name" are accepted wherever a path is expected.
- Deletions go to .trash/ and every mutation is git-snapshotted — mistakes are recoverable, but say what you changed.`;

export interface McpServerOptions {
  /** Called after each tool invocation for audit logging. */
  onToolCall?: (tool: string, args: Record<string, unknown>, result: CallToolResult) => void;
  principal?: AuthPrincipal;
  db?: Database;
}

/**
 * Compose the base instructions with vault-specific guidance: the in-vault
 * AGENTS.md (synced, the owner's source of truth) and any guidance set in the
 * management UI. Both are optional and appended under their own headings.
 */
export function buildInstructions(ctx: VaultContext): string {
  let out = SERVER_INSTRUCTIONS;
  const agents = ctx.vaultGuide()?.trim();
  if (agents) {
    out += `\n\n## Vault guide (AGENTS.md)\nThe vault's own AGENTS.md — follow it when working in the vault:\n\n${agents}`;
  }
  const guidance = ctx.ownerGuidance()?.trim();
  if (guidance) {
    out += `\n\n## Vault-specific guidance from the owner\nFollow this when working in the vault:\n\n${guidance}`;
  }
  return out;
}

export function createMcpServer(ctx: VaultContext, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "obsidian-mcp", version: "0.1.0" },
    { instructions: buildInstructions(ctx) },
  );

  // wrap registerTool so every call is reported to the audit sink
  if (opts.onToolCall) {
    const orig = server.registerTool.bind(server);
    const onCall = opts.onToolCall;
    (server.registerTool as unknown) = (name: string, config: unknown, handler: (...a: unknown[]) => Promise<CallToolResult>) =>
      orig(name as string, config as never, (async (args: Record<string, unknown>, extra: unknown) => {
        const result = await handler(args ?? {}, extra);
        try {
          onCall(name, args ?? {}, result);
        } catch {}
        return result;
      }) as never);
  }

  registerVaultInfo(server, ctx);
  registerVaultConfig(server, ctx);
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
