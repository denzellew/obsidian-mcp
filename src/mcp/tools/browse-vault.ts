import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { safePath } from "../../vault/paths.ts";
import type { DirEntry } from "../../vault/store.ts";

export function registerBrowseVault(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "browse_vault",
    {
      title: "Browse folders",
      description:
        "List a folder or render a folder tree. Use this to explore vault STRUCTURE; to find notes by content or name, search_vault is usually the better tool. " +
        "format:'tree' renders a compact indented tree (cheapest way to orient yourself in a new vault); format:'list' returns entries with sizes and timestamps, sortable by 'modified' to see recent activity. " +
        ".obsidian/.git/.trash are hidden; pass path:'.trash' explicitly to browse deleted notes for recovery.",
      inputSchema: {
        path: z.string().default("").describe("Folder to list; '' = vault root."),
        format: z.enum(["list", "tree"]).default("list"),
        depth: z.number().int().min(1).max(6).default(3).describe("Tree depth (tree mode only)."),
        sort: z.enum(["name", "modified"]).default("name").describe("'modified' sorts newest first (list mode)."),
        include_attachments: z.boolean().default(true),
        max_results: z.number().int().min(1).max(1000).default(200),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const rel = safePath(args.path);
      const hidden = rel.startsWith(".trash") || rel.startsWith(".obsidian");

      if (args.format === "tree") {
        const lines: string[] = [rel ? `${rel}/` : "(vault root)"];
        let count = 0;
        const walk = (dir: string, prefix: string, depth: number) => {
          if (depth > args.depth || count > 2000) return;
          let entries: DirEntry[];
          try {
            entries = ctx.store.list(dir, { includeHidden: hidden });
          } catch {
            return;
          }
          if (!args.include_attachments) entries = entries.filter((e) => e.type !== "attachment");
          const shown = entries.slice(0, 50);
          for (const e of shown) {
            count++;
            lines.push(`${prefix}${e.type === "folder" ? `${e.name}/` : e.name}`);
            if (e.type === "folder") walk(e.path, `${prefix}  `, depth + 1);
          }
          if (entries.length > shown.length) lines.push(`${prefix}… (+${entries.length - shown.length} more)`);
        };
        walk(rel, "  ", 1);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      let entries = ctx.store.list(rel, { includeHidden: hidden });
      if (!args.include_attachments) entries = entries.filter((e) => e.type !== "attachment");
      if (args.sort === "modified") {
        entries.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      }
      const offset = args.cursor ? Number.parseInt(Buffer.from(args.cursor, "base64url").toString(), 10) || 0 : 0;
      const page = entries.slice(offset, offset + args.max_results);
      const truncated = offset + args.max_results < entries.length;
      return ok({
        path: rel,
        entries: page,
        total: entries.length,
        ...(truncated ? { next_cursor: Buffer.from(String(offset + args.max_results)).toString("base64url") } : {}),
      });
    }),
  );
}
