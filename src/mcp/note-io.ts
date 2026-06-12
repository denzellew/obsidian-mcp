import type { VaultContext } from "./context.ts";
import { VaultError } from "../vault/store.ts";
import { isMarkdown, safePath, withMdExtension } from "../vault/paths.ts";
import { parseNote } from "../vault/frontmatter.ts";
import { noteTitle, outline } from "../vault/markdown.ts";
import { suggestPaths } from "./respond.ts";

export const MAX_BODY_CHARS = 50_000;
export const DEFAULT_LINE_LIMIT = 2000;

/**
 * Resolve user input to an existing vault path. Accepts vault-relative paths
 * (".md" optional) and bare wikilink targets ("Home Lab"). Throws NOT_FOUND
 * with did-you-mean suggestions.
 */
export async function resolveExistingNote(ctx: VaultContext, input: string): Promise<string> {
  const cleaned = safePath(input);
  if (cleaned && ctx.store.exists(cleaned) && !ctx.store.isDirectory(cleaned)) return cleaned;
  const withMd = withMdExtension(cleaned);
  if (ctx.store.exists(withMd) && !ctx.store.isDirectory(withMd)) return withMd;
  // wikilink-style resolution (basename match, shortest path wins)
  await ctx.links.refresh();
  const resolved = ctx.links.resolve(input);
  if (resolved && ctx.store.exists(resolved)) return resolved;
  const all = [...ctx.store.walkFiles()].map((f) => f.path);
  const suggestions = suggestPaths(all, input);
  throw new VaultError(
    "NOT_FOUND",
    `No note found for '${input}'.${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""} Use search_vault or browse_vault to locate it.`,
  );
}

export interface NotePayload {
  path: string;
  title: string;
  hash: string;
  frontmatter: Record<string, unknown> | null;
  body?: string;
  outline?: { level: number; text: string; line: number }[];
  stat: { modified: string; size_bytes: number; lines: number; words: number };
  truncated?: { lines_shown: string; next_offset: number; hint: string };
}

/** Build the standard note payload (used by read_note, daily_note, create/edit responses). */
export async function notePayload(
  ctx: VaultContext,
  relPath: string,
  opts: { includeBody?: boolean; offset?: number; limit?: number; outlineOnly?: boolean } = {},
): Promise<NotePayload> {
  if (!isMarkdown(relPath)) {
    throw new VaultError("BINARY_FILE", `${relPath} is not a markdown note. Use read_note on .md files; attachments are returned as images or metadata.`);
  }
  const file = await ctx.store.readText(relPath);
  const { frontmatter, body } = parseNote(file.text);
  const allLines = body.split("\n");
  const payload: NotePayload = {
    path: relPath,
    title: noteTitle(relPath, frontmatter, body),
    hash: file.hash,
    frontmatter,
    stat: {
      modified: file.stat.modified,
      size_bytes: file.stat.size_bytes,
      lines: allLines.length,
      words: body.split(/\s+/).filter(Boolean).length,
    },
  };
  if (opts.outlineOnly) {
    payload.outline = outline(body).map((h) => ({ level: h.level, text: h.text, line: h.line + 1 }));
    return payload;
  }
  if (opts.includeBody === false) return payload;

  const offset = opts.offset ?? 1; // 1-based
  const limit = opts.limit ?? DEFAULT_LINE_LIMIT;
  let lines = allLines.slice(offset - 1, offset - 1 + limit);
  let text = lines.join("\n");
  let charTruncated = false;
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS);
    const shown = text.split("\n").length - 1;
    lines = lines.slice(0, shown);
    text = lines.join("\n");
    charTruncated = true;
  }
  payload.body = text;
  const lastShown = offset - 1 + lines.length;
  if (lastShown < allLines.length || charTruncated) {
    payload.truncated = {
      lines_shown: `${offset}-${lastShown}`,
      next_offset: lastShown + 1,
      hint: `Note has ${allLines.length} lines. Pass offset:${lastShown + 1} to continue, or use mode:'outline' to map headings then mode:'section' to read one section.`,
    };
  }
  return payload;
}
