import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok, fail } from "../respond.ts";
import { resolveExistingNote } from "../note-io.ts";
import { rewriteLinks } from "../../vault/links.ts";
import { isMarkdown, safeWritePath, withMdExtension } from "../../vault/paths.ts";

export function registerManageNote(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "manage_note",
    {
      title: "Move / copy / delete note",
      description:
        "Move (= rename), copy, or delete a note or attachment. Delete is soft: the file goes to .trash/ (Obsidian's convention) and every operation is git-snapshotted first, so mistakes are recoverable. " +
        "On move, wikilinks and markdown links in other notes that point at the file are rewritten automatically (update_links:false to skip); the response lists exactly which notes were touched. " +
        "Pass expected_hash from read_note when moving or deleting based on note content you previously read.",
      inputSchema: {
        action: z.enum(["move", "copy", "delete"]),
        path: z.string().describe("Vault-relative path or wikilink target."),
        destination: z.string().optional().describe("Required for move/copy. Folders are created automatically."),
        update_links: z.boolean().default(true).describe("Rewrite links in referencing notes (move only)."),
        expected_hash: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
      annotations: { destructiveHint: true },
    },
    guarded(async (args) => {
      const rel = await resolveExistingNote(ctx, args.path);

      if (args.action === "delete") {
        await ctx.links.refresh();
        const orphaned = [...new Set(ctx.links.backlinks(rel).map((b) => b.source))];
        await ctx.snapshotter.preRisky(`delete ${rel}`);
        const { trashedTo } = await ctx.store.trash(rel, { expectedHash: args.expected_hash });
        ctx.snapshotter.noteMutation(`mcp: delete ${rel}`);
        return ok({
          action: "delete",
          path: rel,
          trashed_to: trashedTo,
          ...(orphaned.length
            ? { now_unresolved_links_in: orphaned, hint: "These notes still link to the deleted note; the links are now unresolved." }
            : {}),
        });
      }

      if (!args.destination) return fail("INVALID_ARGS", `${args.action} requires a destination path.`);
      let dest = safeWritePath(args.destination);
      if (isMarkdown(rel)) dest = withMdExtension(dest);

      if (args.action === "copy") {
        await ctx.store.copy(rel, dest, { overwrite: args.overwrite });
        ctx.snapshotter.noteMutation(`mcp: copy ${rel} -> ${dest}`);
        return ok({ action: "copy", path: rel, destination: dest });
      }

      // capture backlinks against the PRE-move index: after the move the old
      // path resolves to nothing and backlinks(rel) would come up empty
      await ctx.links.refresh();
      const sources = args.update_links
        ? [...new Set(ctx.links.backlinks(rel).map((b) => b.source))].filter((s) => s !== rel)
        : [];

      await ctx.snapshotter.preRisky(`move ${rel} -> ${dest}`);
      await ctx.store.move(rel, dest, { expectedHash: args.expected_hash, overwrite: args.overwrite });

      const updated: string[] = [];
      const settings = ctx.settings();
      for (const source of sources) {
        // the pre-move index still resolves old link targets to `rel`
        const file = await ctx.store.readText(source);
        const out = rewriteLinks(file.text, source, rel, dest, settings.newLinkFormat, ctx.links);
        if (out !== null) {
          await ctx.store.write(source, out, { expectedHash: file.hash });
          updated.push(source);
        }
      }
      await ctx.links.refresh();
      ctx.snapshotter.noteMutation(`mcp: move ${rel} -> ${dest}`);
      return ok({
        action: "move",
        path: rel,
        destination: dest,
        links_updated: { files: updated, count: updated.length },
      });
    }),
  );
}
