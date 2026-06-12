import { logger } from "../log.ts";

const log = logger("git");

export class GitError extends Error {
  constructor(
    public args: string[],
    public exitCode: number,
    public stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
  }
}

/**
 * Thin exec wrapper running git against a bare repo with an external worktree
 * (the vault). All snapshot git ops flow through one instance.
 */
export class Git {
  constructor(
    readonly gitDir: string,
    readonly workTree: string,
  ) {}

  async run(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; exitCode: number }> {
    const full = [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args];
    const proc = Bun.spawn(["git", ...full], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "obsidian-mcp",
        GIT_AUTHOR_EMAIL: "snapshots@local",
        GIT_COMMITTER_NAME: "obsidian-mcp",
        GIT_COMMITTER_EMAIL: "snapshots@local",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0 && !opts.allowFail) {
      log.warn(`git ${args[0]} failed`, stderr.trim());
      throw new GitError(args, exitCode, stderr);
    }
    return { stdout, exitCode };
  }

  /** `git init --bare` must run without the --work-tree global flag. */
  static async initBare(gitDir: string): Promise<void> {
    const proc = Bun.spawn(["git", "init", "--bare", "--initial-branch=main", gitDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new GitError(["init", "--bare", gitDir], exitCode, stderr);
  }

  async revParse(ref: string): Promise<string | null> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", ref], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }
}
