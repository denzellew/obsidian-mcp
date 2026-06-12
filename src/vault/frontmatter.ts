import { parse as parseYaml, parseDocument } from "yaml";

export interface ParsedNote {
  /** Parsed YAML frontmatter, null when absent or unparseable */
  frontmatter: Record<string, unknown> | null;
  /** Raw YAML between the --- fences (no fences), null when absent */
  frontmatterRaw: string | null;
  /** Note body without the frontmatter block */
  body: string;
}

const FM_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Split a note into frontmatter + body, the way Obsidian does (fence must be at byte 0). */
export function parseNote(text: string): ParsedNote {
  const match = text.match(FM_PATTERN);
  if (!match) return { frontmatter: null, frontmatterRaw: null, body: text };
  const raw = match[1] ?? "";
  let fm: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed YAML: treat as opaque, body still excludes the block
  }
  return { frontmatter: fm, frontmatterRaw: raw, body: text.slice(match[0].length) };
}

/**
 * Apply set/remove operations to a note's frontmatter, re-serializing only the
 * YAML block (body bytes untouched, key order and comments preserved).
 * Creates the block when missing and `set` is non-empty.
 */
export function patchFrontmatter(
  text: string,
  patch: { set?: Record<string, unknown>; remove?: string[] },
): string {
  const { frontmatterRaw, body } = parseNote(text);
  const doc = parseDocument(frontmatterRaw ?? "");
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    doc.set(key, value);
  }
  for (const key of patch.remove ?? []) {
    doc.delete(key);
  }
  const contents = doc.contents;
  const isEmpty =
    contents == null || (typeof contents === "object" && "items" in contents && contents.items.length === 0);
  if (isEmpty) {
    // removing the last key removes the whole block
    return body;
  }
  let yamlText = doc.toString();
  if (!yamlText.endsWith("\n")) yamlText += "\n";
  return `---\n${yamlText}---\n${body}`;
}

/** Build a complete note string from structured frontmatter + body. */
export function buildNote(frontmatter: Record<string, unknown> | undefined, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const doc = parseDocument("");
  for (const [key, value] of Object.entries(frontmatter)) doc.set(key, value);
  let yamlText = doc.toString();
  if (!yamlText.endsWith("\n")) yamlText += "\n";
  return `---\n${yamlText}---\n${body}`;
}
