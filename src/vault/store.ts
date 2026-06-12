import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isProtected, resolveAbsolute, safePath, safeWritePath } from "./paths.ts";

export class VaultError extends Error {
  constructor(
    public code:
      | "NOT_FOUND"
      | "ALREADY_EXISTS"
      | "STALE_NOTE"
      | "NOT_A_FILE"
      | "NOT_A_FOLDER"
      | "BINARY_FILE"
      | "TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

export interface FileStat {
  modified: string; // ISO 8601
  size_bytes: number;
}

export interface RawFile {
  bytes: Uint8Array;
  hash: string;
  stat: FileStat;
}

export interface TextFile {
  text: string;
  hash: string;
  stat: FileStat;
}

export interface DirEntry {
  path: string;
  name: string;
  type: "note" | "folder" | "attachment";
  size_bytes?: number;
  modified?: string;
  children_count?: number;
}

export function contentHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function toStat(absPath: string): FileStat {
  const s = statSync(absPath);
  return { modified: s.mtime.toISOString(), size_bytes: s.size };
}

/**
 * Filesystem layer for the vault: hashing, atomic writes, per-path mutex,
 * optimistic concurrency. All paths are vault-relative; validation happens
 * here via safePath/safeWritePath so callers can't bypass it.
 */
export class VaultStore {
  private locks = new Map<string, Promise<unknown>>();

  constructor(readonly vaultDir: string) {}

  /** Serialize an async operation per canonical path. */
  async withLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
    const key = safePath(relPath);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(key, tail);
    void tail.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  abs(relPath: string): string {
    return resolveAbsolute(this.vaultDir, relPath);
  }

  exists(relPath: string): boolean {
    return existsSync(this.abs(relPath));
  }

  isDirectory(relPath: string): boolean {
    const abs = this.abs(relPath);
    return existsSync(abs) && statSync(abs).isDirectory();
  }

  stat(relPath: string): FileStat {
    const abs = this.abs(relPath);
    if (!existsSync(abs)) throw new VaultError("NOT_FOUND", `No such file: ${safePath(relPath)}`);
    return toStat(abs);
  }

  async readRaw(relPath: string): Promise<RawFile> {
    const abs = this.abs(relPath);
    if (!existsSync(abs)) throw new VaultError("NOT_FOUND", `No such file: ${safePath(relPath)}`);
    if (statSync(abs).isDirectory()) throw new VaultError("NOT_A_FILE", `${safePath(relPath)} is a folder, not a file`);
    const bytes = new Uint8Array(await readFile(abs));
    return { bytes, hash: contentHash(bytes), stat: toStat(abs) };
  }

  async readText(relPath: string): Promise<TextFile> {
    const raw = await this.readRaw(relPath);
    return { text: new TextDecoder().decode(raw.bytes), hash: raw.hash, stat: raw.stat };
  }

  /**
   * Atomic write with optimistic concurrency.
   * - expectedHash: fail with STALE_NOTE if current content hash differs.
   * - mustNotExist: fail with ALREADY_EXISTS if the file exists.
   * Re-checks inside the per-path lock, writes a temp file, renames into place.
   */
  async write(
    relPath: string,
    content: string,
    opts: { expectedHash?: string; mustNotExist?: boolean; allowTrash?: boolean } = {},
  ): Promise<{ hash: string; stat: FileStat }> {
    const rel = safeWritePath(relPath, { allowTrash: opts.allowTrash });
    return this.withLock(rel, async () => {
      const abs = this.abs(rel);
      const exists = existsSync(abs);
      if (opts.mustNotExist && exists) {
        throw new VaultError("ALREADY_EXISTS", `Note already exists: ${rel}`);
      }
      if (opts.expectedHash !== undefined) {
        if (!exists) {
          throw new VaultError(
            "STALE_NOTE",
            `'${rel}' no longer exists (expected hash ${opts.expectedHash}). It may have been deleted by sync. Re-read or re-create it.`,
          );
        }
        const current = contentHash(new Uint8Array(await readFile(abs)));
        if (current !== opts.expectedHash) {
          throw new VaultError(
            "STALE_NOTE",
            `'${rel}' changed since you read it (expected ${opts.expectedHash}, now ${current} — likely Obsidian Sync). Call read_note('${rel}') to get the current content, then retry against it.`,
          );
        }
      }
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = join(dirname(abs), `.${basename(abs)}.tmp-${randomBytes(4).toString("hex")}`);
      await writeFile(tmp, content, "utf8");
      await rename(tmp, abs);
      const bytes = Buffer.from(content, "utf8");
      return { hash: contentHash(new Uint8Array(bytes)), stat: toStat(abs) };
    });
  }

  /** Move/rename a file. Creates destination folders. */
  async move(
    fromRel: string,
    toRel: string,
    opts: { expectedHash?: string; overwrite?: boolean } = {},
  ): Promise<void> {
    const from = safeWritePath(fromRel);
    const to = safeWritePath(toRel);
    await this.withLock(from, async () => {
      const absFrom = this.abs(from);
      const absTo = this.abs(to);
      if (!existsSync(absFrom)) throw new VaultError("NOT_FOUND", `No such file: ${from}`);
      if (existsSync(absTo) && !opts.overwrite) {
        throw new VaultError("ALREADY_EXISTS", `Destination already exists: ${to}. Pass overwrite:true to replace it.`);
      }
      if (opts.expectedHash !== undefined) {
        const current = contentHash(new Uint8Array(await readFile(absFrom)));
        if (current !== opts.expectedHash) {
          throw new VaultError(
            "STALE_NOTE",
            `'${from}' changed since you read it (expected ${opts.expectedHash}, now ${current}). Re-read it before moving.`,
          );
        }
      }
      mkdirSync(dirname(absTo), { recursive: true });
      renameSync(absFrom, absTo);
    });
  }

  async copy(fromRel: string, toRel: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    const from = safePath(fromRel);
    const to = safeWritePath(toRel);
    const absFrom = this.abs(from);
    const absTo = this.abs(to);
    if (!existsSync(absFrom)) throw new VaultError("NOT_FOUND", `No such file: ${from}`);
    if (existsSync(absTo) && !opts.overwrite) {
      throw new VaultError("ALREADY_EXISTS", `Destination already exists: ${to}. Pass overwrite:true to replace it.`);
    }
    mkdirSync(dirname(absTo), { recursive: true });
    copyFileSync(absFrom, absTo);
  }

  /** Soft-delete: move into .trash/ (Obsidian convention), uniquified on collision. */
  async trash(relPath: string, opts: { expectedHash?: string } = {}): Promise<{ trashedTo: string }> {
    const rel = safeWritePath(relPath);
    return this.withLock(rel, async () => {
      const abs = this.abs(rel);
      if (!existsSync(abs)) throw new VaultError("NOT_FOUND", `No such file: ${rel}`);
      if (opts.expectedHash !== undefined) {
        const current = contentHash(new Uint8Array(await readFile(abs)));
        if (current !== opts.expectedHash) {
          throw new VaultError(
            "STALE_NOTE",
            `'${rel}' changed since you read it (expected ${opts.expectedHash}, now ${current}). Re-read it before deleting.`,
          );
        }
      }
      const name = basename(rel);
      let target = `.trash/${name}`;
      if (existsSync(this.abs(target))) {
        const ext = extname(name);
        const stem = name.slice(0, name.length - ext.length);
        for (let i = 1; ; i++) {
          target = `.trash/${stem} ${i}${ext}`;
          if (!existsSync(this.abs(target))) break;
        }
      }
      const absTarget = this.abs(target);
      mkdirSync(dirname(absTarget), { recursive: true });
      renameSync(abs, absTarget);
      return { trashedTo: target };
    });
  }

  /** Permanently remove a file (used internally, e.g. tmp cleanup). */
  remove(relPath: string) {
    const rel = safeWritePath(relPath, { allowTrash: true });
    unlinkSync(this.abs(rel));
  }

  /**
   * List a folder. Protected dirs are hidden at the vault root unless
   * explicitly listed (e.g. browse_vault {path: ".trash"}).
   */
  list(relPath: string, opts: { includeHidden?: boolean } = {}): DirEntry[] {
    const rel = safePath(relPath);
    const abs = this.abs(rel);
    if (!existsSync(abs)) throw new VaultError("NOT_FOUND", `No such folder: ${rel || "/"}`);
    if (!statSync(abs).isDirectory()) throw new VaultError("NOT_A_FOLDER", `${rel} is a file, not a folder`);
    const entries: DirEntry[] = [];
    for (const name of readdirSync(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!opts.includeHidden && rel === "" && isProtected(childRel)) continue;
      if (name.startsWith(".") && !opts.includeHidden && rel === "") continue;
      const childAbs = join(abs, name);
      let s;
      try {
        s = statSync(childAbs);
      } catch {
        continue; // racing with sync daemon deletions
      }
      if (s.isDirectory()) {
        let count = 0;
        try {
          count = readdirSync(childAbs).length;
        } catch {}
        entries.push({ path: childRel, name, type: "folder", modified: s.mtime.toISOString(), children_count: count });
      } else {
        entries.push({
          path: childRel,
          name,
          type: name.toLowerCase().endsWith(".md") ? "note" : "attachment",
          size_bytes: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    }
    entries.sort((a, b) => (a.type === "folder" ? 0 : 1) - (b.type === "folder" ? 0 : 1) || a.name.localeCompare(b.name));
    return entries;
  }

  /** Recursively walk all files (not folders), skipping protected dirs. */
  *walkFiles(relPath = ""): Generator<{ path: string; name: string }> {
    const rel = safePath(relPath);
    const abs = this.abs(rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (isProtected(childRel)) continue;
      if (name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      let s;
      try {
        s = statSync(childAbs);
      } catch {
        continue;
      }
      if (s.isDirectory()) yield* this.walkFiles(childRel);
      else yield { path: childRel, name };
    }
  }
}
