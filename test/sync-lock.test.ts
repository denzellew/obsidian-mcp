import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { writeLock, clearLock, reapStrayOb } from "../src/sync/lock.ts";

let dir: string;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obmcp-lock-"));
  config = { ...loadConfig({ DATA_DIR: dir } as unknown as NodeJS.ProcessEnv), obConfigDir: dir };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("sync lock", () => {
  test("write/clear lockfile", () => {
    const lock = join(dir, "sync.lock");
    writeLock(config, 12345);
    expect(existsSync(lock)).toBe(true);
    clearLock(config);
    expect(existsSync(lock)).toBe(false);
  });

  test("reap is a no-op with no lock or a dead pid", () => {
    expect(() => reapStrayOb(config)).not.toThrow();
    writeLock(config, 999999); // almost certainly not alive
    expect(() => reapStrayOb(config)).not.toThrow();
  });

  test("reaps a live ob-like process recorded in the lock", async () => {
    // a process whose command line looks like ob sync for this vault
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    // record it as the lock holder; on Linux looksLikeObSync checks /proc and
    // would reject a plain `sleep`, so spawn one that matches on both platforms
    proc.kill("SIGKILL");
    await proc.exited;

    const obLike = Bun.spawn(
      ["bash", "-c", `exec -a "ob sync --path ${config.vaultDir} --continuous" sleep 30`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 100));
    const pid = obLike.pid;
    writeLock(config, pid);

    expect(alive(pid)).toBe(true);
    reapStrayOb(config);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);

    try {
      obLike.kill("SIGKILL");
    } catch {}
  });

  test("does not target our own pid", () => {
    writeLock(config, process.pid);
    reapStrayOb(config);
    expect(alive(process.pid)).toBe(true); // still here
  });
});
