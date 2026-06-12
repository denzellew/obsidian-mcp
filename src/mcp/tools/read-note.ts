import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok, fail } from "../respond.ts";
import { notePayload, resolveExistingNote } from "../note-io.ts";
import { findSection } from "../../vault/markdown.ts";
import { parseNote } from "../../vault/frontmatter.ts";
import { isImage, isMarkdown } from "../../vault/paths.ts";

const MAX_IMAGE_BYTES = 1_500_000;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

export function registerReadNote(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read one or more notes: parsed frontmatter, markdown body, and a `hash` you MUST keep if you plan to edit — pass it as expected_hash to edit_note/manage_note since this vault can change underneath you (Obsidian Sync runs continuously). " +
        "`path` accepts a vault-relative path ('Projects/Foo.md', '.md' optional) or a bare wikilink target ('Foo'), resolved the way Obsidian resolves [[Foo]]. " +
        "For large notes use mode:'outline' (headings only, cheap) then mode:'section' with `heading` to read one section. Use `paths` to batch-read up to 10 notes in one call. " +
        "Image attachments are returned as viewable images; other binaries return metadata only.",
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path or wikilink target. Mutually exclusive with `paths`."),
        paths: z.array(z.string()).max(10).optional().describe("Batch read up to 10 notes."),
        mode: z.enum(["full", "outline", "section"]).default("full"),
        heading: z.string().optional().describe("Required for mode:'section'. Heading text, any level; '## ' prefix optional."),
        offset: z.number().int().min(1).optional().describe("1-based start line for huge notes."),
        limit: z.number().int().min(1).max(5000).optional().describe("Max lines to return (default 2000)."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args): Promise<CallToolResult> => {
      if (!args.path && !args.paths?.length) return fail("INVALID_ARGS", "Provide `path` or `paths`.");
      if (args.path && args.paths?.length) return fail("INVALID_ARGS", "`path` and `paths` are mutually exclusive.");

      if (args.paths?.length) {
        const results = [];
        for (const p of args.paths) {
          try {
            const rel = await resolveExistingNote(ctx, p);
            results.push(await notePayload(ctx, rel, { offset: args.offset, limit: args.limit }));
          } catch (err) {
            results.push({ path: p, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return ok({ notes: results });
      }

      const rel = await resolveExistingNote(ctx, args.path!);

      if (!isMarkdown(rel)) {
        if (isImage(rel)) {
          const raw = await ctx.store.readRaw(rel);
          if (raw.bytes.byteLength > MAX_IMAGE_BYTES) {
            return ok({
              path: rel,
              type: "image",
              note: `Image is ${raw.stat.size_bytes} bytes — too large to display inline (limit ${MAX_IMAGE_BYTES}).`,
              stat: raw.stat,
            });
          }
          const ext = rel.split(".").pop()!.toLowerCase();
          return {
            content: [
              { type: "image", data: Buffer.from(raw.bytes).toString("base64"), mimeType: MIME[ext] ?? "application/octet-stream" },
              { type: "text", text: JSON.stringify({ path: rel, hash: raw.hash, stat: raw.stat }) },
            ],
          };
        }
        const stat = ctx.store.stat(rel);
        return ok({ path: rel, type: "binary", note: "Binary file; cannot display content.", stat });
      }

      if (args.mode === "outline") {
        return ok(await notePayload(ctx, rel, { outlineOnly: true }));
      }

      if (args.mode === "section") {
        if (!args.heading) return fail("INVALID_ARGS", "mode:'section' requires `heading`. Use mode:'outline' first to list headings.");
        const file = await ctx.store.readText(rel);
        const { frontmatter, body } = parseNote(file.text);
        const section = findSection(body, args.heading);
        if (!section) {
          const heads = (await notePayload(ctx, rel, { outlineOnly: true })).outline!.map((h) => h.text);
          return fail(
            "NOT_FOUND",
            `No heading '${args.heading}' in ${rel}. Headings: ${heads.join(" | ") || "(none)"}.`,
          );
        }
        const lines = body.split("\n").slice(section.start, section.end);
        const base = await notePayload(ctx, rel, { includeBody: false });
        return ok({ ...base, frontmatter, section: { heading: section.heading.text, lines: `${section.start + 1}-${section.end}`, body: lines.join("\n") } });
      }

      return ok(await notePayload(ctx, rel, { offset: args.offset, limit: args.limit }));
    }),
  );
}
