import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

  /** Debounced commit after a mutation; maxWait bounds long edit sessions. */
  noteMutation(reason: string): void {
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

  /** Content of a file at a commit, or null when it didn't exist. */
  async fileAt(sha: string, path: string): Promise<string | null> {
    const r = await this.git.run(["show", `${sha}:${path}`], { allowFail: true });
    return r.exitCode === 0 ? r.stdout : null;
  }
}
