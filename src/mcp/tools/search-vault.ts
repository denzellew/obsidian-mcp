import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { searchVault } from "../../vault/search.ts";

export function registerSearchVault(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "search_vault",
    {
      title: "Search vault",
      description:
        "Search the vault by content, filename, and tags in one call — this is almost always the right way to FIND notes (use browse_vault only to explore folder structure). " +
        "Plain-text queries by default; set regex:true for patterns. Filters compose: {query:'kubernetes', tag:'project', folder:'Work'} finds the term only in Work-folder notes tagged #project (nested tags match: tag:'project' includes #project/acme). " +
        "Matches are highlighted with «guillemets». Results are paginated (default 20 notes); when truncated:true, refine the query or pass cursor rather than raising max_results. " +
        "To search frontmatter fields use a regex like '^status: draft'. Returned paths feed directly into read_note.",
      inputSchema: {
        query: z.string().optional().describe("Literal text (default) or regex. Required unless `tag` is given."),
        regex: z.boolean().default(false),
        scope: z.array(z.enum(["content", "filename"])).optional().describe("Default: both."),
        tag: z.string().optional().describe("Only notes carrying this tag (frontmatter or inline; matches nested children)."),
        folder: z.string().optional().describe("Restrict to a subtree."),
        modified_after: z.string().optional().describe("ISO date, e.g. '2026-06-01'."),
        case_sensitive: z.boolean().default(false),
        context_lines: z.number().int().min(0).max(4).default(1).describe("Context lines around matches (detailed mode)."),
        max_results: z.number().int().min(1).max(100).default(20),
        response_format: z.enum(["concise", "detailed"]).default("concise").describe("detailed: up to 10 matches per note with context."),
        cursor: z.string().optional().describe("Pagination token from a previous truncated response."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const result = await searchVault(ctx.store, {
        query: args.query,
        regex: args.regex,
        scope: args.scope,
        tag: args.tag,
        folder: args.folder,
        modifiedAfter: args.modified_after ? new Date(args.modified_after) : undefined,
        caseSensitive: args.case_sensitive,
        contextLines: args.context_lines,
        maxResults: args.max_results,
        detailed: args.response_format === "detailed",
        cursor: args.cursor,
      });
      return ok({
        ...result,
        ...(result.truncated
          ? { hint: `${result.total_notes} notes matched; narrow with folder/tag filters, or pass next_cursor to continue.` }
          : {}),
      });
    }),
  );
}
