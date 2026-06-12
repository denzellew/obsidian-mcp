import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok, fail } from "../respond.ts";
import { notePayload, resolveExistingNote } from "../note-io.ts";
import { parseNote, patchFrontmatter } from "../../vault/frontmatter.ts";
import { appendUnderHeading, replaceSection } from "../../vault/markdown.ts";
import { isMarkdown } from "../../vault/paths.ts";

const EditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace"),
    old_text: z.string().min(1).describe("Exact text to find — must match byte-for-byte including whitespace."),
    new_text: z.string(),
    occurrence: z.union([z.number().int().min(1), z.literal("all")]).optional()
      .describe("Disambiguate multiple matches: 1-based index, or 'all'. Omit when the match is unique."),
  }),
  z.object({
    type: z.literal("append"),
    content: z.string().min(1),
    heading: z.string().optional().describe("Append at the end of this section instead of the end of the note. Created if missing."),
  }),
  z.object({
    type: z.literal("prepend"),
    content: z.string().min(1).describe("Inserted after frontmatter, before the first body line."),
  }),
  z.object({
    type: z.literal("replace_section"),
    heading: z.string(),
    content: z.string(),
    keep_heading: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("set_frontmatter"),
    set: z.record(z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("replace_content"),
    content: z.string().describe("Replaces the whole body. Frontmatter is preserved. Requires expected_hash."),
  }),
]);

export function registerEditNote(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Edit an existing note with surgical, anchor-based operations. ALWAYS call read_note first and pass its `hash` as `expected_hash` — this vault syncs continuously and files can change underneath you; the hash check turns a silent overwrite into a safe retry. " +
        "Prefer 'replace' (exact-match find/replace) or 'append' over 'replace_content'; whole-body replacement REQUIRES expected_hash and should be a last resort. " +
        "old_text must match the note exactly (copy it from read_note output) and be unique — otherwise pass `occurrence`. " +
        "Use 'set_frontmatter' to change metadata (never hand-edit the YAML block with 'replace'). " +
        "Multiple edits apply top-to-bottom atomically: all succeed or none are written. Every mutation is git-snapshotted and recoverable. Returns the new `hash` — keep it for further edits.",
      inputSchema: {
        path: z.string().describe("Vault-relative path or wikilink target."),
        expected_hash: z.string().optional().describe("hash from read_note. Required for replace_content; strongly recommended otherwise."),
        edits: z.array(EditSchema).min(1),
      },
      annotations: { destructiveHint: true },
    },
    guarded(async (args) => {
      const rel = await resolveExistingNote(ctx, args.path);
      if (!isMarkdown(rel)) return fail("BINARY_FILE", `${rel} is not a markdown note; edit_note only works on .md files.`);

      if (!args.expected_hash && args.edits.some((e) => e.type === "replace_content")) {
        return fail(
          "INVALID_ARGS",
          "replace_content requires expected_hash. Call read_note first, pass its `hash`, and prefer a surgical 'replace' edit if you only need to change part of the note.",
        );
      }

      const file = await ctx.store.readText(rel);
      if (args.expected_hash && args.expected_hash !== file.hash) {
        return fail(
          "STALE_NOTE",
          `'${rel}' changed since you read it (expected ${args.expected_hash}, now ${file.hash} — likely Obsidian Sync). Call read_note('${rel}') and retry your edit against the current content.`,
        );
      }

      let text = file.text;
      for (const [i, edit] of args.edits.entries()) {
        const where = `edit ${i + 1} (${edit.type})`;
        switch (edit.type) {
          case "replace": {
            const parts = text.split(edit.old_text);
            const count = parts.length - 1;
            if (count === 0) {
              return fail(
                "NO_MATCH",
                `${where}: old_text not found in ${rel}. Copy the exact text (including whitespace) from read_note output. If the note changed, re-read it first.`,
              );
            }
            if (count > 1 && edit.occurrence === undefined) {
              return fail(
                "AMBIGUOUS_MATCH",
                `${where}: old_text matches ${count} times in ${rel}. Pass occurrence (1-${count}) or 'all', or use a longer old_text that is unique.`,
              );
            }
            if (edit.occurrence === "all" || count === 1) {
              text = parts.join(edit.new_text);
            } else {
              const n = edit.occurrence as number;
              if (n > count) return fail("NO_MATCH", `${where}: occurrence ${n} requested but only ${count} matches exist.`);
              text = parts.slice(0, n).join(edit.old_text) + edit.new_text + parts.slice(n).join(edit.old_text);
            }
            break;
          }
          case "append": {
            const { frontmatter, body } = splitKeepingFm(text);
            if (edit.heading) {
              const { body: newBody } = appendUnderHeading(body, edit.heading, edit.content);
              text = frontmatter + newBody;
            } else {
              const base = body.replace(/\n+$/, "");
              text = `${frontmatter}${base.length ? `${base}\n` : ""}${edit.content.replace(/\n+$/, "")}\n`;
            }
            break;
          }
          case "prepend": {
            const { frontmatter, body } = splitKeepingFm(text);
            text = `${frontmatter}${edit.content.replace(/\n+$/, "")}\n${body}`;
            break;
          }
          case "replace_section": {
            const { frontmatter, body } = splitKeepingFm(text);
            const out = replaceSection(body, edit.heading, edit.content, edit.keep_heading);
            if (out === null) {
              const { body: b } = splitKeepingFm(text);
              const heads = headsOf(b);
              return fail("NOT_FOUND", `${where}: no heading '${edit.heading}' in ${rel}. Headings: ${heads || "(none)"}.`);
            }
            text = frontmatter + out;
            break;
          }
          case "set_frontmatter": {
            if (!edit.set && !edit.remove) return fail("INVALID_ARGS", `${where}: provide set and/or remove.`);
            text = patchFrontmatter(text, { set: edit.set as Record<string, unknown> | undefined, remove: edit.remove });
            break;
          }
          case "replace_content": {
            const { frontmatter } = splitKeepingFm(text);
            text = frontmatter + edit.content;
            break;
          }
        }
      }

      // write with the hash we read — concurrent changes since our read fail safely
      const result = await ctx.store.write(rel, text, { expectedHash: file.hash });
      ctx.snapshotter.noteMutation(`mcp: edit_note ${rel}`);
      const payload = await notePayload(ctx, rel, { includeBody: false });
      return ok({ ...payload, hash: result.hash, edits_applied: args.edits.length });
    }),
  );
}

/** Split into raw frontmatter block (with fences, or "") + body. */
function splitKeepingFm(text: string): { frontmatter: string; body: string } {
  const { body } = parseNote(text);
  return { frontmatter: text.slice(0, text.length - body.length), body };
}

function headsOf(body: string): string {
  const seen: string[] = [];
  let m;
  const re = /^#{1,6}\s+(.+)$/gm;
  while ((m = re.exec(body)) && seen.length < 20) seen.push(m[1]!.trim());
  return seen.join(" | ");
}
