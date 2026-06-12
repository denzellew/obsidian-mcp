import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/index.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { SyncSupervisor } from "../src/sync/supervisor.ts";
import type { Database } from "bun:sqlite";

let dir: string;
let db: Database;

function fakeOb(script: string): string {
  const path = join(dir, "fake-ob");
  writeFileSync(path, `#!/bin/sh\n${script}`);
  chmodSync(path, 0o755);
  return path;
}

function makeConfig(obBin: string): Config {
  return {
    ...loadConfig({ DATA_DIR: dir } as unknown as NodeJS.ProcessEnv),
    obBin,
    obKillGraceMs: 300,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obmcp-sup-"));
  db = openDatabase(":memory:");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("SyncSupervisor", () => {
  test("captures output and reports running", async () => {
    const bin = fakeOb(`echo "syncing stuff"\nsleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), db);
    sup.start();
    await waitFor(() => sup.recentLog().join("\n").includes("syncing stuff"));
    const status = sup.status();
    expect(status.state).toBe("running");
    expect(status.pid).toBeGreaterThan(0);
    expect(status.log.join("\n")).toContain("syncing stuff");
    await sup.shutdown();
  });

  test("SIGKILL fallback when ob ignores SIGTERM", async () => {
    const bin = fakeOb(`trap '' TERM\necho "stubborn"\nwhile true; do sleep 1; done`);
    const sup = new SyncSupervisor(makeConfig(bin), db);
    sup.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(sup.status().state).toBe("running");
    const t0 = Date.now();
    await sup.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280); // waited out the grace period
    expect(sup.status().state).toBe("stopped");
    expect(sup.recentLog().join("\n")).toContain("SIGKILL");
  });

  test("crash triggers backoff restart and desired state persists", async () => {
    const bin = fakeOb(`echo "boom"\nexit 1`);
    const sup = new SyncSupervisor(makeConfig(bin), db);
    sup.start();
    await new Promise((r) => setTimeout(r, 400));
    const status = sup.status();
    expect(status.desired).toBe(true);
    expect(status.restartAttempts).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toContain("restarting");
    await sup.shutdown();

    // a new supervisor (simulated restart) sees desired=running
    const sup2 = new SyncSupervisor(makeConfig(bin), db);
    expect(sup2.desiredRunning()).toBe(true);
  });

  test("stop clears desired state; autostart respects it", async () => {
    const bin = fakeOb(`sleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), db);
    sup.start();
    await new Promise((r) => setTimeout(r, 200));
    await sup.stop();
    expect(sup.desiredRunning()).toBe(false);
    const sup2 = new SyncSupervisor(makeConfig(bin), db);
    sup2.autostart();
    await new Promise((r) => setTimeout(r, 200));
    expect(sup2.status().state).toBe("idle");
  });

  test("missing binary surfaces a clear error", async () => {
    const sup = new SyncSupervisor(makeConfig("/nonexistent/ob"), db);
    sup.start();
    await new Promise((r) => setTimeout(r, 200));
    const status = sup.status();
    expect(["error"]).toContain(status.state);
    await sup.shutdown();
  });
});
