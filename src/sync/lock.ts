import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { logger } from "../log.ts";

const log = logger("sync-lock");

/**
 * A PID lockfile guards against more than one `ob sync --continuous` running
 * against the same vault folder — the main risk being a child orphaned by a
 * hard process restart (e.g. `bun --watch` HMR) that keeps syncing while a new
 * supervisor starts another. Two writers on one folder corrupt sync state.
 */
function lockPath(config: Config): string {
  return join(config.obConfigDir, "sync.lock");
}

export function writeLock(config: Config, pid: number): void {
  try {
    writeFileSync(lockPath(config), JSON.stringify({ pid, vaultDir: config.vaultDir }));
  } catch (err) {
    log.warn("could not write sync lock", err);
  }
}

export function clearLock(config: Config): void {
  try {
    const p = lockPath(config);
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort confirmation that `pid` is actually an ob-sync process for this
 * vault, so the reaper never kills an unrelated process that reused the PID.
 * Uses /proc on Linux (the container); on macOS dev /proc is absent, and since
 * the PID came from our own lockfile we treat it as ours.
 */
function looksLikeObSync(pid: number, vaultDir: string): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return cmdline.includes("sync") && cmdline.includes(vaultDir);
  } catch {
    return true;
  }
}

/**
 * Kill any ob-sync process left over from a prior run against this vault.
 * Call before spawning. `ownChildPid` (if known) is never targeted.
 */
export function reapStrayOb(config: Config, ownChildPid?: number): void {
  try {
    const p = lockPath(config);
    if (!existsSync(p)) return;
    const { pid } = JSON.parse(readFileSync(p, "utf8")) as { pid?: number };
    if (!pid || pid === ownChildPid || pid === process.pid) return;
    if (alive(pid) && looksLikeObSync(pid, config.vaultDir)) {
      try {
        process.kill(pid, "SIGKILL");
        log.warn(`reaped stray ob sync (pid ${pid}) on ${config.vaultDir} — leftover from a prior run`);
      } catch {}
    }
  } catch {}
}
