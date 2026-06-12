import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

/** Directories the server never writes to and hides from search/browse by default. */
export const PROTECTED_DIRS = [".obsidian", ".git", ".trash"] as const;

export class VaultPathError extends Error {
  constructor(
    public code: "INVALID_PATH" | "PROTECTED_PATH",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalize and validate a vault-relative path. Returns the canonical
 * vault-relative path (forward slashes, NFC, no leading slash).
 * This is the single chokepoint all tools must pass paths through.
 */
export function safePath(relPath: string): string {
  if (typeof relPath !== "string") throw new VaultPathError("INVALID_PATH", "Path must be a string");
  if (relPath.includes("\0")) throw new VaultPathError("INVALID_PATH", "Path contains a null byte");
  let p = relPath.normalize("NFC").replaceAll("\\", "/").trim();
  p = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  if (isAbsolute(p)) throw new VaultPathError("INVALID_PATH", `Path must be vault-relative: ${relPath}`);
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new VaultPathError("INVALID_PATH", `Path must not contain '..': ${relPath}`);
  }
  return normalize(p).replaceAll(sep, "/");
}

/** True if the path is inside one of the protected directories. */
export function isProtected(relPath: string): boolean {
  const first = relPath.split("/")[0];
  return PROTECTED_DIRS.includes(first as (typeof PROTECTED_DIRS)[number]);
}

/**
 * Validate a path for writing: safePath + protected-dir rejection.
 * `allowTrash` permits writes into .trash/ (used by delete itself).
 */
export function safeWritePath(relPath: string, opts: { allowTrash?: boolean } = {}): string {
  const p = safePath(relPath);
  if (p === "") throw new VaultPathError("INVALID_PATH", "Cannot write to the vault root itself");
  if (isProtected(p)) {
    const dir = p.split("/")[0];
    if (!(opts.allowTrash && dir === ".trash")) {
      throw new VaultPathError(
        "PROTECTED_PATH",
        `Writes under ${dir}/ are not allowed. The server never modifies Obsidian config (${dir === ".obsidian" ? "vault settings live here" : "internal directory"}).`,
      );
    }
  }
  return p;
}

/**
 * Resolve a vault-relative path to an absolute path, verifying (via realpath
 * of the deepest existing ancestor) that it cannot escape the vault through
 * symlinks. Returns the absolute path; the file itself need not exist.
 */
export function resolveAbsolute(vaultDir: string, relPath: string): string {
  const rel = safePath(relPath);
  const vaultReal = realpathSync(vaultDir);
  const abs = join(vaultReal, rel);
  // realpath the deepest existing ancestor and confirm containment
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== vaultReal && !real.startsWith(vaultReal + sep)) {
        throw new VaultPathError("INVALID_PATH", `Path escapes the vault: ${relPath}`);
      }
      break;
    } catch (err) {
      if (err instanceof VaultPathError) throw err;
      const parent = join(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
  }
  return abs;
}

/** Append ".md" when the path has no file extension (notes addressed without one). */
export function withMdExtension(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  if (base.includes(".") && !base.startsWith(".")) return relPath;
  return `${relPath}.md`;
}

export function isMarkdown(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".md");
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export function isImage(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}
