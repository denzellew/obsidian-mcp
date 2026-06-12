import { statSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { VaultStore } from "./store.ts";
import { isMarkdown } from "./paths.ts";

export interface NoteLink {
  /** Raw link target as written (no alias/heading/extension processing) */
  target: string;
  heading: string | null;
  alias: string | null;
  embed: boolean;
  /** 1-based line number */
  line: number;
  /** "wiki" or "markdown" */
  style: "wiki" | "markdown";
  /** Resolved vault-relative path, or null if unresolved */
  resolved: string | null;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  links: NoteLink[];
}

const WIKILINK = /(!)?\[\[([^\[\]\|#]+)(#[^\[\]\|]*)?(\|[^\[\]]*)?\]\]/g;
const MDLINK = /(!)?\[([^\]]*)\]\(([^)\s]+)\)/g;
const FENCE = /^(```|~~~)/;

/** Parse all links out of a markdown body. Resolution is filled in later. */
export function parseLinks(body: string): Omit<NoteLink, "resolved">[] {
  const links: Omit<NoteLink, "resolved">[] = [];
  let inFence = false;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    if (FENCE.test(rawLine.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const m of line.matchAll(WIKILINK)) {
      const target = m[2]!.trim();
      if (!target) continue;
      links.push({
        target,
        heading: m[3] ? m[3].slice(1).trim() || null : null,
        alias: m[4] ? m[4].slice(1).trim() || null : null,
        embed: m[1] === "!",
        line: i + 1,
        style: "wiki",
      });
    }
    for (const m of line.matchAll(MDLINK)) {
      const url = m[3]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // external scheme
      if (url.startsWith("#")) continue; // same-note anchor
      const [pathPart, headingPart] = url.split("#");
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathPart ?? "");
      } catch {
        decoded = pathPart ?? "";
      }
      if (!decoded) continue;
      links.push({
        target: decoded,
        heading: headingPart ? decodeURIComponent(headingPart) : null,
        alias: m[2] || null,
        embed: m[1] === "!",
        line: i + 1,
        style: "markdown",
      });
    }
  }
  return links;
}

/**
 * Maintains a lazily-built, mtime-invalidated index of links across the vault.
 * No fs-watching: the sync daemon churns files, so each access re-stats and
 * re-parses only changed notes.
 */
export class LinkIndex {
  private files = new Map<string, FileEntry>();
  /** basename (lowercased, no .md) -> paths */
  private basenames = new Map<string, string[]>();

  constructor(private store: VaultStore) {}

  /** Re-scan the vault, re-parsing only files whose mtime/size changed. */
  async refresh(): Promise<void> {
    const seen = new Set<string>();
    const mdFiles: string[] = [];
    const allFiles: string[] = [];
    for (const f of this.store.walkFiles()) {
      allFiles.push(f.path);
      if (isMarkdown(f.path)) mdFiles.push(f.path);
    }
    // rebuild basename map from the full current file list
    this.basenames = new Map();
    for (const p of allFiles) {
      const base = (p.split("/").pop() ?? p).replace(/\.md$/i, "").toLowerCase();
      const list = this.basenames.get(base);
      if (list) list.push(p);
      else this.basenames.set(base, [p]);
    }
    for (const list of this.basenames.values()) {
      list.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    }

    for (const path of mdFiles) {
      seen.add(path);
      let s;
      try {
        s = statSync(this.store.abs(path));
      } catch {
        continue;
      }
      const cached = this.files.get(path);
      if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) continue;
      try {
        const { text } = await this.store.readText(path);
        const links = parseLinks(text).map((l) => ({ ...l, resolved: null as string | null }));
        this.files.set(path, { mtimeMs: s.mtimeMs, size: s.size, links });
      } catch {
        this.files.delete(path);
      }
    }
    for (const path of this.files.keys()) {
      if (!seen.has(path)) this.files.delete(path);
    }
    // resolve all links against the fresh basename map
    for (const [from, entry] of this.files) {
      for (const link of entry.links) {
        link.resolved = this.resolve(link.target, from);
      }
    }
  }

  /**
   * Resolve a link target the way Obsidian does:
   * 1. Path-ish targets (contain "/"): exact vault path, .md auto-appended.
   * 2. Bare names: basename match anywhere; shortest path wins, ties alphabetical.
   * 3. Case-insensitive throughout (Obsidian is case-insensitive in practice).
   */
  resolve(target: string, fromPath = ""): string | null {
    const clean = target.replace(/^\/+/, "").replace(/\\/g, "/").trim();
    if (!clean) return null;
    const hasExt = /\.[A-Za-z0-9]+$/.test(clean);
    const names = hasExt ? [clean] : [`${clean}.md`, clean];
    const probes = [...names];
    if (fromPath) {
      const dir = dirname(fromPath);
      if (dir !== ".") probes.push(...names.map((n) => `${dir}/${n}`));
    }
    for (const probe of probes) {
      const exact = this.findByPath(probe);
      if (exact) return exact;
    }
    // basename lookup
    const base = (clean.split("/").pop() ?? clean).replace(/\.md$/i, "").toLowerCase();
    const matches = this.basenames.get(base);
    if (!matches || matches.length === 0) return null;
    if (clean.includes("/")) {
      // path-style target that didn't match exactly: match by suffix
      const suffix = clean.replace(/\.md$/i, "").toLowerCase();
      const bySuffix = matches.find((p) => p.replace(/\.md$/i, "").toLowerCase().endsWith(suffix));
      return bySuffix ?? null;
    }
    return matches[0] ?? null;
  }

  private findByPath(path: string): string | null {
    const lower = path.toLowerCase();
    for (const p of this.files.keys()) {
      if (p.toLowerCase() === lower) return p;
    }
    // attachments aren't in this.files; check basenames map (full paths)
    for (const list of this.basenames.values()) {
      for (const p of list) {
        if (p.toLowerCase() === lower) return p;
      }
    }
    return null;
  }

  /** All links pointing at `path` (resolved), grouped by source note. */
  backlinks(path: string): { source: string; link: NoteLink }[] {
    const out: { source: string; link: NoteLink }[] = [];
    const lower = path.toLowerCase();
    for (const [from, entry] of this.files) {
      for (const link of entry.links) {
        if (link.resolved && link.resolved.toLowerCase() === lower) out.push({ source: from, link });
      }
    }
    return out;
  }

  outgoing(path: string): NoteLink[] {
    return this.files.get(path)?.links ?? [];
  }

  /** True if a bare basename is unique vault-wide (for "shortest" link format). */
  isBasenameUnique(path: string): boolean {
    const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "").toLowerCase();
    return (this.basenames.get(base)?.length ?? 0) <= 1;
  }
}

/** Compute the link target text for a destination, honoring app.json newLinkFormat. */
export function linkTargetFor(
  destPath: string,
  fromPath: string,
  format: "shortest" | "relative" | "absolute",
  index: LinkIndex,
): string {
  const noExt = destPath.replace(/\.md$/i, "");
  switch (format) {
    case "shortest": {
      const base = noExt.split("/").pop()!;
      return index.isBasenameUnique(destPath) ? base : noExt;
    }
    case "relative": {
      const rel = relative(dirname(fromPath) === "." ? "" : dirname(fromPath), noExt);
      return rel.replaceAll("\\", "/");
    }
    case "absolute":
      return noExt;
  }
}

/**
 * Rewrite all links in `sourceText` that resolve to `oldPath` so they point at
 * `newPath`. Returns the new text, or null when nothing changed.
 */
export function rewriteLinks(
  sourceText: string,
  sourcePath: string,
  oldPath: string,
  newPath: string,
  format: "shortest" | "relative" | "absolute",
  index: LinkIndex,
): string | null {
  const lower = oldPath.toLowerCase();
  let changed = false;

  const rewriteWiki = (text: string) =>
    text.replace(WIKILINK, (all, embed: string | undefined, target: string, heading?: string, alias?: string) => {
      const resolved = index.resolve(target.trim(), sourcePath);
      if (!resolved || resolved.toLowerCase() !== lower) return all;
      changed = true;
      const newTarget = linkTargetFor(newPath, sourcePath, format, index);
      return `${embed ?? ""}[[${newTarget}${heading ?? ""}${alias ?? ""}]]`;
    });

  const rewriteMd = (text: string) =>
    text.replace(MDLINK, (all, embed: string | undefined, label: string, url: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return all;
      const [pathPart, headingPart] = url.split("#");
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathPart ?? "");
      } catch {
        return all;
      }
      const resolved = index.resolve(decoded, sourcePath);
      if (!resolved || resolved.toLowerCase() !== lower) return all;
      changed = true;
      const keepExt = /\.md$/i.test(decoded) ? newPath : newPath.replace(/\.md$/i, "");
      const encoded = keepExt.split("/").map(encodeURIComponent).join("/");
      return `${embed ?? ""}[${label}](${encoded}${headingPart ? `#${headingPart}` : ""})`;
    });

  // apply line-by-line, skipping code fences
  const lines = sourceText.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = rewriteMd(rewriteWiki(line));
  }
  return changed ? lines.join("\n") : null;
}
