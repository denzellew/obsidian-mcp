import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.ts";
import { logger } from "../log.ts";

const log = logger("snapshots");

const EXCLUDES = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/cache/",
  ".trash/",
  ".DS_Store",
].join("\n");

export interface SnapshotterOptions {
  debounceMs: number;
  maxWaitMs: number;
  intervalMs: number;
}

/** git's well-known empty tree, used as the parent of the root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Refs accepted from callers (MCP). Anything else is rejected before reaching
 * git, so a value like "--output=/x" can never be parsed as an option.
 */
const REF_RE = /^(HEAD|[0-9a-f]{4,40})([~^][0-9]{0,4})*$/i;

export class SnapshotRefError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface DiffFile {
  path: string;
  /** A added, M modified, D deleted, R renamed (old path in `from_path`). */
  status: string;
  from_path?: string;
  additions: number | null;
  deletions: number | null;
}

export interface DiffResult {
  from: string;
  /** Resolved sha, or null for the current working tree. */
  to: string | null;
  files: DiffFile[];
  patch: string;
}

export interface CommitInfo {
  sha: string;
  date: string;
  message: string;
}

/**
 * Automatic git snapshots of the vault. Bare repo lives outside the vault;
 * every git op runs with --git-dir/--work-tree so no .git pollutes the vault.
 * All operations are serialized through one queue (single index, no locks).
 */
export class Snapshotter {
  readonly git: Git;
  private queue: Promise<unknown> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pendingReason: string | null = null;
  private onMutation: ((reason: string) => void) | null = null;

  constructor(
    snapshotsDir: string,
    readonly vaultDir: string,
    private opts: SnapshotterOptions,
  ) {
    this.git = new Git(join(snapshotsDir, "vault.git"), vaultDir);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async init(): Promise<void> {
    if (!existsSync(this.git.gitDir)) {
      mkdirSync(this.git.gitDir, { recursive: true });
      await Git.initBare(this.git.gitDir);
      log.info(`initialized snapshot repo at ${this.git.gitDir}`);
    }
    writeFileSync(join(this.git.gitDir, "info", "exclude"), `${EXCLUDES}\n`);
    // catch anything that changed while we were down
    await this.commit("startup");
  }

  /** Commit now if the worktree is dirty. Serialized; safe to call anytime. */
  commit(reason: string): Promise<string | null> {
    return this.enqueue(async () => {
      try {
        await this.git.run(["add", "-A"]);
        const diff = await this.git.run(["diff", "--cached", "--quiet"], { allowFail: true });
        if (diff.exitCode === 0) return null; // nothing staged
        await this.git.run(["commit", "-m", reason]);
        const sha = await this.git.revParse("HEAD");
        log.info(`snapshot ${sha?.slice(0, 7)} (${reason})`);
        return sha;
      } catch (err) {
        log.error(`snapshot failed (${reason})`, err);
        return null;
      }
    });
  }

  /** Notified for every local mutation, before the debounced snapshot commit. */
  setMutationListener(fn: ((reason: string) => void) | null): void {
    this.onMutation = fn;
  }

  /** Debounced commit after a mutation; maxWait bounds long edit sessions. */
  noteMutation(reason: string): void {
    this.onMutation?.(reason);
    this.pendingReason = reason;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushPending(), this.opts.debounceMs);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.flushPending(), this.opts.maxWaitMs);
    }
  }

  private flushPending(): Promise<string | null> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    if (this.pendingReason === null) return Promise.resolve(null);
    const reason = this.pendingReason;
    this.pendingReason = null;
    return this.commit(reason);
  }

  /** Flush any pending debounced commit and wait for the queue to drain. */
  async flush(): Promise<void> {
    await this.flushPending();
    await this.queue;
  }

  /** Synchronous restore point immediately before a destructive op. */
  async preRisky(reason: string): Promise<void> {
    await this.commit(`pre-op: ${reason}`);
  }

  startTimers(): void {
    this.intervalTimer = setInterval(() => void this.commit("timer:interval"), this.opts.intervalMs);
  }

  async shutdown(): Promise<void> {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    await this.flush();
    await this.commit("shutdown");
    await this.queue;
  }

  async listCommits(limit = 50, path?: string): Promise<CommitInfo[]> {
    const head = await this.git.revParse("HEAD");
    if (!head) return [];
    const args = ["log", `--max-count=${limit}`, "--pretty=format:%H%x09%cI%x09%s"];
    if (path) args.push("--", path);
    const { stdout } = await this.git.run(args);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...rest] = line.split("\t");
        return { sha: sha!, date: date!, message: rest.join("\t") };
      });
  }

  /** Files changed in a commit. */
  async commitFiles(sha: string): Promise<string[]> {
    const { stdout } = await this.git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]);
    return stdout.split("\n").filter(Boolean);
  }

  /** Validate a caller-supplied ref and resolve it to a full sha. */
  async resolveRef(ref: string): Promise<string> {
    if (!REF_RE.test(ref)) {
      throw new SnapshotRefError(`'${ref}' is not a valid snapshot ref. Use a sha from snapshot_history, or HEAD / HEAD~N.`);
    }
    const sha = await this.git.revParse(`${ref}^{commit}`);
    if (!sha) throw new SnapshotRefError(`Snapshot '${ref}' not found. Call snapshot_history to list available snapshots.`);
    return sha;
  }

  /**
   * Diff between snapshots, or from a snapshot to the current working tree
   * (to omitted). `commit` diffs a single snapshot against its parent.
   */
  async diff(opts: { from?: string; to?: string; commit?: string; path?: string; context?: number } = {}): Promise<DiffResult> {
    const head = await this.git.revParse("HEAD");
    if (!head) throw new SnapshotRefError("No snapshots exist yet, so there is nothing to diff against.");
    let from: string;
    let to: string | null;
    if (opts.commit) {
      to = await this.resolveRef(opts.commit);
      from = (await this.git.revParse(`${to}^`)) ?? EMPTY_TREE;
    } else {
      from = await this.resolveRef(opts.from ?? "HEAD");
      to = opts.to ? await this.resolveRef(opts.to) : null;
    }
    const common = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "-M"];
    const pathArgs = opts.path ? ["--", opts.path] : [];

    const run = async (env?: Record<string, string>) => {
      const range = to ? [from, to] : ["--cached", from];
      const ctxArg = `-U${opts.context ?? 3}`;
      const [patch, status, numstat] = await Promise.all([
        this.git.run([...common, ctxArg, ...range, ...pathArgs], { env }),
        this.git.run([...common, "--name-status", "-z", ...range, ...pathArgs], { env }),
        this.git.run([...common, "--numstat", "-z", ...range, ...pathArgs], { env }),
      ]);
      return { from, to, patch: patch.stdout, files: parseFiles(status.stdout, numstat.stdout) };
    };

    if (to) return this.enqueue(() => run());
    // Working-tree diff via a throwaway index, so untracked files show up and
    // the real index (owned by commit()) is never touched.
    return this.enqueue(async () => {
      const indexFile = join(this.git.gitDir, `diff-index-${process.pid}-${Date.now()}`);
      const env = { GIT_INDEX_FILE: indexFile };
      try {
        await this.git.run(["read-tree", "HEAD"], { env });
        await this.git.run(["add", "-A"], { env });
        return await run(env);
      } finally {
        rmSync(indexFile, { force: true });
      }
    });
  }

  /** Content of a file at a commit, or null when it didn't exist. */
  async fileAt(sha: string, path: string): Promise<string | null> {
    const r = await this.git.run(["show", `${sha}:${path}`], { allowFail: true });
    return r.exitCode === 0 ? r.stdout : null;
  }
}

/** Merge `--name-status -z` and `--numstat -z` output into one list. */
function parseFiles(nameStatus: string, numstat: string): DiffFile[] {
  const files: DiffFile[] = [];
  const ns = nameStatus.split("\0");
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++]!;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const fromPath = ns[i++]!;
      files.push({ path: ns[i++]!, status: letter, from_path: fromPath, additions: null, deletions: null });
    } else {
      files.push({ path: ns[i++]!, status: letter, additions: null, deletions: null });
    }
  }
  // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0"
  const counts = new Map<string, [number | null, number | null]>();
  const nm = numstat.split("\0");
  for (let i = 0; i < nm.length - 1; ) {
    const [a, d, p] = nm[i++]!.split("\t");
    let path = p;
    if (!path) {
      i++; // old path
      path = nm[i++];
    }
    const n = (v: string | undefined) => (v === undefined || v === "-" ? null : Number(v));
    if (path) counts.set(path, [n(a), n(d)]);
  }
  for (const f of files) {
    const c = counts.get(f.path);
    if (c) [f.additions, f.deletions] = c;
  }
  return files;
}
