import { extractInlineTags, frontmatterTags, noteTitle } from "./markdown.ts";
import { parseNote } from "./frontmatter.ts";
import { isMarkdown, safePath } from "./paths.ts";
import type { VaultStore } from "./store.ts";

export interface SearchOptions {
  query?: string;
  regex?: boolean;
  scope?: ("content" | "filename")[];
  tag?: string;
  folder?: string;
  modifiedAfter?: Date;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  detailed?: boolean;
  cursor?: string;
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResultNote {
  path: string;
  title: string;
  modified: string;
  matched: "content" | "filename" | "tag";
  match_count: number;
  matches: SearchMatch[];
  conflict?: boolean;
}

export interface SearchResponse {
  results: SearchResultNote[];
  total_notes: number;
  truncated: boolean;
  next_cursor?: string;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const MAX_LINE_SNIPPET = 240;

function makeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function readCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    return typeof parsed.o === "number" && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    throw new SearchError("Invalid cursor. Pass the next_cursor value from a previous search_vault response, unmodified.");
  }
}

/** Tag match incl. nested children: "project" matches "project" and "project/acme". */
function tagMatches(noteTags: string[], wanted: string): boolean {
  const w = wanted.replace(/^#/, "").toLowerCase();
  return noteTags.some((t) => {
    const lt = t.toLowerCase();
    return lt === w || lt.startsWith(`${w}/`);
  });
}

function buildMatcher(opts: SearchOptions): RegExp | null {
  if (!opts.query) return null;
  const flags = opts.caseSensitive ? "g" : "gi";
  if (opts.regex) {
    try {
      return new RegExp(opts.query, flags);
    } catch (err) {
      throw new SearchError(
        `Invalid regex: ${err instanceof Error ? err.message : String(err)}. Fix the pattern or set regex:false for a literal search.`,
      );
    }
  }
  return new RegExp(opts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

function highlight(line: string, matcher: RegExp): { text: string; count: number } {
  let count = 0;
  matcher.lastIndex = 0;
  const text = line.replace(matcher, (m) => {
    count++;
    return `«${m}»`;
  });
  return { text, count };
}

function snippet(text: string): string {
  if (text.length <= MAX_LINE_SNIPPET) return text.trim();
  const first = text.indexOf("«");
  const start = Math.max(0, first - 60);
  const slice = text.slice(start, start + MAX_LINE_SNIPPET);
  return `${start > 0 ? "…" : ""}${slice.trim()}…`;
}

export async function searchVault(store: VaultStore, opts: SearchOptions): Promise<SearchResponse> {
  if (!opts.query && !opts.tag) {
    throw new SearchError("Provide a query, a tag, or both.");
  }
  const scope = opts.scope?.length ? opts.scope : ["content", "filename"];
  const matcher = buildMatcher(opts);
  const folder = opts.folder ? safePath(opts.folder) : null;
  const maxResults = Math.min(opts.maxResults ?? 20, 100);
  const contextLines = Math.min(opts.contextLines ?? 1, 4);
  const maxMatchesPerNote = opts.detailed ? 10 : 3;
  const offset = readCursor(opts.cursor);

  const all: SearchResultNote[] = [];

  for (const file of store.walkFiles(folder ?? "")) {
    const path = file.path;
    const md = isMarkdown(path);
    if (!md && !scope.includes("filename")) continue;

    let stat;
    try {
      stat = store.stat(path);
    } catch {
      continue;
    }
    if (opts.modifiedAfter && new Date(stat.modified) < opts.modifiedAfter) continue;

    let text: string | null = null;
    let fm: Record<string, unknown> | null = null;
    let body = "";
    if (md) {
      // content needed for matching, tag filtering, and the title

      try {
        ({ text } = await store.readText(path));
      } catch {
        continue;
      }
      const parsed = parseNote(text);
      fm = parsed.frontmatter;
      body = parsed.body;
    }

    if (opts.tag) {
      if (!md) continue;
      const tags = [...frontmatterTags(fm), ...extractInlineTags(body)];
      if (!tagMatches(tags, opts.tag)) continue;
    }

    const matches: SearchMatch[] = [];
    let matchCount = 0;
    let matchedVia: SearchResultNote["matched"] | null = opts.tag && !matcher ? "tag" : null;

    if (matcher) {
      let found = false;
      if (scope.includes("filename")) {
        matcher.lastIndex = 0;
        if (matcher.test(path)) {
          found = true;
          matchedVia = "filename";
        }
      }
      if (md && scope.includes("content") && text !== null) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const { text: hl, count } = highlight(lines[i]!, matcher);
          if (count === 0) continue;
          found = true;
          matchedVia = "content";
          matchCount += count;
          if (matches.length < maxMatchesPerNote) {
            if (contextLines > 0 && opts.detailed) {
              const from = Math.max(0, i - contextLines);
              const to = Math.min(lines.length - 1, i + contextLines);
              const ctx = lines
                .slice(from, to + 1)
                .map((l, j) => (from + j === i ? hl : l))
                .join("\n");
              matches.push({ line: i + 1, text: snippet(ctx) });
            } else {
              matches.push({ line: i + 1, text: snippet(hl) });
            }
          }
        }
      }
      if (!found) continue;
    }

    all.push({
      path,
      title: md ? noteTitle(path, fm, body) : (path.split("/").pop() ?? path),
      modified: stat.modified,
      matched: matchedVia ?? "tag",
      match_count: matchCount,
      matches,
      ...(path.toLowerCase().includes("(conflicted copy") ? { conflict: true } : {}),
    });
  }

  all.sort((a, b) => b.match_count - a.match_count || a.path.localeCompare(b.path));

  const page = all.slice(offset, offset + maxResults);
  const truncated = offset + maxResults < all.length;
  return {
    results: page,
    total_notes: all.length,
    truncated,
    ...(truncated ? { next_cursor: makeCursor(offset + maxResults) } : {}),
  };
}
