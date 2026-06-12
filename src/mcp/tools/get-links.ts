import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { resolveExistingNote } from "../note-io.ts";

export function registerGetLinks(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "get_links",
    {
      title: "Backlinks & outgoing links",
      description:
        "Connections of a note: backlinks (notes linking TO it, with the line of context), outgoing links (with their resolved paths), embedded attachments, and unresolved links (targets that don't exist yet — candidate notes to create). " +
        "Use this to traverse the knowledge graph around a note or to check impact before reorganizing.",
      inputSchema: {
        path: z.string().describe("Vault-relative path or wikilink target."),
        direction: z.enum(["both", "in", "out"]).default("both"),
        include_context: z.boolean().default(true).describe("Include the source line containing each backlink."),
        max_results: z.number().int().min(1).max(200).default(50).describe("Per direction."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const rel = await resolveExistingNote(ctx, args.path);
      await ctx.links.refresh();

      const payload: Record<string, unknown> = { path: rel };

      if (args.direction !== "out") {
        const back = ctx.links.backlinks(rel).slice(0, args.max_results);
        const contextCache = new Map<string, string[]>();
        const backlinks = [];
        for (const { source, link } of back) {
          let context: string | undefined;
          if (args.include_context) {
            if (!contextCache.has(source)) {
              try {
                contextCache.set(source, (await ctx.store.readText(source)).text.split("\n"));
              } catch {
                contextCache.set(source, []);
              }
            }
            context = contextCache.get(source)![link.line - 1]?.trim();
          }
          backlinks.push({ source, line: link.line, ...(context ? { context } : {}) });
        }
        payload.backlinks = backlinks;
      }

      if (args.direction !== "in") {
        const out = ctx.links.outgoing(rel);
        payload.outgoing = out
          .filter((l) => !l.embed && l.resolved)
          .slice(0, args.max_results)
          .map((l) => ({ target: l.target, resolved: l.resolved, line: l.line }));
        payload.embeds = out
          .filter((l) => l.embed)
          .slice(0, args.max_results)
          .map((l) => ({ target: l.target, resolved: l.resolved, line: l.line }));
        payload.unresolved = out
          .filter((l) => !l.embed && !l.resolved)
          .slice(0, args.max_results)
          .map((l) => ({ target: l.target, line: l.line }));
      }

      return ok(payload);
    }),
  );
}
