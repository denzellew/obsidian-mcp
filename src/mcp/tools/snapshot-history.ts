import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { resolveSnapshotPath } from "./vault-diff.ts";

export function registerSnapshotHistory(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "snapshot_history",
    {
      title: "Snapshot history",
      description:
        "List the vault's git snapshots, newest first. Every mutation (yours, the user's via Obsidian Sync, and periodic timers) is snapshotted, so this is the change log of the vault. " +
        "Use it to find shas to pass to vault_diff (e.g. vault_diff {commit: sha} shows what one snapshot changed), or pass a path to see the history of a single note — including notes that were since deleted or moved.",
      inputSchema: {
        path: z.string().optional().describe("Only snapshots touching this vault-relative path or wikilink target."),
        limit: z.number().int().min(1).max(100).default(20),
        include_files: z.boolean().default(false).describe("List the files each snapshot changed."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const path = args.path ? await resolveSnapshotPath(ctx, args.path) : undefined;
      const commits = await ctx.snapshotter.listCommits(args.limit, path);
      const out = [];
      for (const c of commits) {
        out.push({
          sha: c.sha.slice(0, 12),
          date: c.date,
          message: c.message,
          ...(args.include_files ? { files: await ctx.snapshotter.commitFiles(c.sha) } : {}),
        });
      }
      return ok({ ...(path ? { path } : {}), commits: out });
    }),
  );
}
