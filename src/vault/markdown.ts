export interface Heading {
  level: number;
  text: string;
  /** 0-based line index in the body */
  line: number;
}

const FENCE = /^(```|~~~)/;
const ATX = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

/** Extract ATX headings, ignoring code fences. */
export function outline(body: string): Heading[] {
  const lines = body.split("\n");
  const headings: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(ATX);
    if (m) headings.push({ level: m[1]!.length, text: m[2]!.trim(), line: i });
  }
  return headings;
}

export interface Section {
  heading: Heading;
  /** 0-based line of the heading */
  start: number;
  /** exclusive 0-based end line (start of next same-or-higher heading, or EOF) */
  end: number;
}

/**
 * Find a section by heading text. Matching is case-insensitive and tolerates a
 * leading "## " prefix in the query ("## Log" and "Log" both match).
 */
export function findSection(body: string, heading: string): Section | null {
  const query = heading.replace(/^#{1,6}\s+/, "").trim().toLowerCase();
  const headings = outline(body);
  const idx = headings.findIndex((h) => h.text.toLowerCase() === query);
  if (idx === -1) return null;
  const target = headings[idx]!;
  const lines = body.split("\n");
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j]!.level <= target.level) {
      end = headings[j]!.line;
      break;
    }
  }
  return { heading: target, start: target.line, end };
}

/** Append content at the end of a section (before the next same-or-higher heading). */
export function appendUnderHeading(body: string, heading: string, content: string): { body: string; created: boolean } {
  const section = findSection(body, heading);
  const block = content.replace(/\n+$/, "");
  if (!section) {
    // create the heading at the end of the note
    const headingLine = /^#{1,6}\s/.test(heading) ? heading : `## ${heading}`;
    const base = body.replace(/\n+$/, "");
    const prefix = base.length > 0 ? `${base}\n\n` : "";
    return { body: `${prefix}${headingLine}\n\n${block}\n`, created: true };
  }
  const lines = body.split("\n");
  // skip trailing blank lines inside the section so we insert tight to content
  let insertAt = section.end;
  while (insertAt > section.start + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
  lines.splice(insertAt, 0, block);
  return { body: lines.join("\n"), created: false };
}

/** Replace a section's content (keeping or dropping the heading line). */
export function replaceSection(
  body: string,
  heading: string,
  content: string,
  keepHeading = true,
): string | null {
  const section = findSection(body, heading);
  if (!section) return null;
  const lines = body.split("\n");
  const block = content.replace(/\n+$/, "");
  const replacement = keepHeading ? [lines[section.start]!, block] : [block];
  lines.splice(section.start, section.end - section.start, ...replacement);
  return lines.join("\n");
}

/** Obsidian tag grammar: letters/digits/-/_//, must contain a non-digit. */
const INLINE_TAG = /(^|[\s(])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

/** Extract inline #tags from a body (skipping code fences and inline code). */
export function extractInlineTags(body: string): string[] {
  const tags = new Set<string>();
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    if (FENCE.test(rawLine.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, ""); // strip inline code
    for (const m of line.matchAll(INLINE_TAG)) {
      tags.add(m[2]!);
    }
  }
  return [...tags];
}

/** Normalize frontmatter `tags` (string, comma string, or array) to a list. */
export function frontmatterTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const raw = fm.tags ?? fm.tag;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter((t) => t.length > 0);
}

/** Title for a note: frontmatter title > first H1 > basename without extension. */
export function noteTitle(path: string, fm: Record<string, unknown> | null, body: string): string {
  if (fm && typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  const h1 = outline(body).find((h) => h.level === 1);
  if (h1) return h1.text;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
