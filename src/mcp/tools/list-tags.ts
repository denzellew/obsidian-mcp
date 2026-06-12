import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { parseNote } from "../../vault/frontmatter.ts";
import { extractInlineTags, frontmatterTags } from "../../vault/markdown.ts";
import { isMarkdown } from "../../vault/paths.ts";

export function registerListTags(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "All tags in the vault (both frontmatter tags and inline #tags, including nested like project/acme) with usage counts. " +
        "To find the NOTES carrying a tag, use search_vault with the `tag` parameter.",
      inputSchema: {
        prefix: z.string().optional().describe("Only tags starting with this prefix (e.g. 'project')."),
        sort: z.enum(["count", "name"]).default("count"),
        max_results: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const counts = new Map<string, number>();
      for (const file of ctx.store.walkFiles()) {
        if (!isMarkdown(file.path)) continue;
        let text: string;
        try {
          text = (await ctx.store.readText(file.path)).text;
        } catch {
          continue;
        }
        const { frontmatter, body } = parseNote(text);
        const tags = new Set([...frontmatterTags(frontmatter), ...extractInlineTags(body)]);
        for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const prefix = args.prefix?.replace(/^#/, "").toLowerCase();
      let tags = [...counts.entries()]
        .filter(([t]) => !prefix || t.toLowerCase().startsWith(prefix))
        .map(([tag, count]) => ({ tag, count }));
      tags.sort(args.sort === "count" ? (a, b) => b.count - a.count || a.tag.localeCompare(b.tag) : (a, b) => a.tag.localeCompare(b.tag));
      const total = tags.length;
      tags = tags.slice(0, args.max_results);
      return ok({ tags, total });
    }),
  );
}
