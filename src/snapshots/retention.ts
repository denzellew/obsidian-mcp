import type { Git } from "./git.ts";
import { logger } from "../log.ts";

const log = logger("retention");

/**
 * Squash history older than `retentionDays` into a single parentless baseline
 * commit, re-parenting the newer chain on top, then expire reflogs and gc.
 * Markdown deltas are tiny so this rarely matters for disk, but it keeps the
 * commit list browsable.
 */
export async function squashOldHistory(git: Git, retentionDays: number, now = new Date()): Promise<boolean> {
  const head = await git.revParse("HEAD");
  if (!head) return false;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();

  // newest commit strictly older than the cutoff becomes the baseline
  const older = await git.run(["rev-list", "--max-count=1", `--before=${cutoff}`, "HEAD"]);
  const baselineSrc = older.stdout.trim();
  if (!baselineSrc) return false;

  // is there anything below it to squash?
  const parents = await git.run(["rev-list", "--max-count=2", baselineSrc]);
  if (parents.stdout.trim().split("\n").length < 2) return false;

  const tree = (await git.run(["rev-parse", `${baselineSrc}^{tree}`])).stdout.trim();
  let newParent = (
    await git.run(["commit-tree", tree, "-m", `baseline (history squashed before ${cutoff.slice(0, 10)})`])
  ).stdout.trim();

  // re-parent everything newer than the baseline, oldest first
  const newer = (await git.run(["rev-list", "--reverse", `${baselineSrc}..HEAD`])).stdout
    .split("\n")
    .filter(Boolean);
  for (const sha of newer) {
    const t = (await git.run(["rev-parse", `${sha}^{tree}`])).stdout.trim();
    const msg = (await git.run(["show", "-s", "--format=%s", sha])).stdout.trim();
    newParent = (await git.run(["commit-tree", t, "-p", newParent, "-m", msg])).stdout.trim();
  }

  await git.run(["update-ref", "refs/heads/main", newParent]);
  await git.run(["reflog", "expire", "--expire=now", "--all"], { allowFail: true });
  await git.run(["gc", "--prune=now", "--quiet"], { allowFail: true });
  log.info(`squashed history before ${cutoff.slice(0, 10)} (${newer.length} commits re-parented)`);
  return true;
}
