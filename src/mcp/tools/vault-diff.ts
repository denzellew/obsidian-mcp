import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { fail, guarded, ok } from "../respond.ts";
import { resolveExistingNote } from "../note-io.ts";
import { safePath } from "../../vault/paths.ts";
import { VaultError } from "../../vault/store.ts";

/**
 * Resolve a path for history lookups: existing notes resolve like everywhere
 * else (wikilinks accepted), but a path that no longer exists is still valid —
 * it may have been deleted or moved since the snapshot.
 */
export async function resolveSnapshotPath(ctx: VaultContext, input: string): Promise<string> {
  try {
    return await resolveExistingNote(ctx, input);
  } catch (err) {
    if (err instanceof VaultError && err.code === "NOT_FOUND") return safePath(input);
    throw err;
  }
}

export function registerVaultDiff(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "vault_diff",
    {
      title: "Git diff of the vault",
      description:
        "Unified git diff of vault changes, from the automatic snapshots. With no arguments: everything changed since the last snapshot (recent edits not yet snapshotted, including ones from Obsidian Sync). " +
        "commit: what a single snapshot changed. from/to: compare two snapshots, or from a snapshot to the current files (omit to). Refs are shas from snapshot_history, or HEAD / HEAD~N. " +
        "Use it to review what changed (e.g. at the start of a session, or to check your own edits). Large diffs are truncated — narrow with path, or use stat_only first to see which files changed.",
      inputSchema: {
        commit: z.string().optional().describe("Show only the changes made by this snapshot (vs its parent). Excludes from/to."),
        from: z.string().optional().describe("Base snapshot. Default HEAD (the latest snapshot)."),
        to: z.string().optional().describe("Target snapshot. Omit to compare against the current files."),
        path: z.string().optional().describe("Limit to a vault-relative path, folder, or wikilink target."),
        context_lines: z.number().int().min(0).max(20).default(3),
        stat_only: z.boolean().default(false).describe("Only list changed files with line counts, no patch."),
        max_chars: z.number().int().min(500).max(100_000).default(20_000),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      if (args.commit && (args.from || args.to)) {
        return fail("INVALID_ARGS", "Pass either commit, or from/to — not both.");
      }
      const path = args.path ? await resolveSnapshotPath(ctx, args.path) : undefined;
      const r = await ctx.snapshotter.diff({
        commit: args.commit,
        from: args.from,
        to: args.to,
        path: path || undefined,
        context: args.context_lines,
      });
      const payload: Record<string, unknown> = {
        from: r.from.slice(0, 12),
        to: r.to ? r.to.slice(0, 12) : "working tree",
        ...(path ? { path } : {}),
        files: r.files,
      };
      if (r.files.length === 0) payload.note = "No changes.";
      if (!args.stat_only) {
        const truncated = r.patch.length > args.max_chars;
        payload.patch = truncated ? r.patch.slice(0, args.max_chars) : r.patch;
        if (truncated) {
          payload.truncated = true;
          payload.hint = `Patch is ${r.patch.length} chars; showing the first ${args.max_chars}. Narrow with path (one file from 'files'), or raise max_chars.`;
        }
      }
      return ok(payload);
    }),
  );
}
