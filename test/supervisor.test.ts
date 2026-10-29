import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, vaultSettings, type VaultSettings } from "../src/db/index.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { SyncSupervisor } from "../src/sync/supervisor.ts";

let dir: string;
let settings: VaultSettings;

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
  settings = vaultSettings(openDatabase(":memory:"), 1);
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
    const sup = new SyncSupervisor(makeConfig(bin), settings);
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
    const sup = new SyncSupervisor(makeConfig(bin), settings);
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
    const sup = new SyncSupervisor(makeConfig(bin), settings);
    sup.start();
    await waitFor(() => sup.status().restartAttempts >= 1);
    const status = sup.status();
    expect(status.desired).toBe(true);
    expect(status.restartAttempts).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toContain("restarting");
    await sup.shutdown();

    // a new supervisor (simulated restart) sees desired=running
    const sup2 = new SyncSupervisor(makeConfig(bin), settings);
    expect(sup2.desiredRunning()).toBe(true);
  });

  test("stop clears desired state; autostart respects it", async () => {
    const bin = fakeOb(`sleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), settings);
    sup.start();
    await new Promise((r) => setTimeout(r, 200));
    await sup.stop();
    expect(sup.desiredRunning()).toBe(false);
    const sup2 = new SyncSupervisor(makeConfig(bin), settings);
    sup2.autostart();
    await new Promise((r) => setTimeout(r, 200));
    expect(sup2.status().state).toBe("idle");
  });

  test("missing binary surfaces a clear error", async () => {
    const sup = new SyncSupervisor(makeConfig("/nonexistent/ob"), settings);
    sup.start();
    await new Promise((r) => setTimeout(r, 200));
    const status = sup.status();
    expect(["error"]).toContain(status.state);
    await sup.shutdown();
  });

  test("restarts when a local change is not uploaded after the scan settles", async () => {
    const bin = fakeOb(`echo "Connection successful. Detecting changes..."\necho "Fully synced"\nsleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), settings, { uploadStallMs: 200, connectStallMs: 30_000 });
    sup.start();
    await waitFor(() => sup.recentLog().join("\n").includes("Fully synced"));
    sup.noteLocalChange();
    await waitFor(() => sup.recentLog().join("\n").includes("was not uploaded"), 2000);
    expect(sup.recentLog().join("\n")).toContain("was not uploaded");
    expect(sup.status().restartAttempts).toBeGreaterThanOrEqual(1);
    await sup.shutdown();
  });

  test("an upload cancels the stall restart", async () => {
    const signal = join(dir, "uploaded");
    const bin = fakeOb(
      `echo "Fully synced"\nwhile [ ! -f "${signal}" ]; do sleep 0.05; done\necho "Upload complete notes/a.md"\nsleep 60`,
    );
    const sup = new SyncSupervisor(makeConfig(bin), settings, { uploadStallMs: 800, connectStallMs: 30_000 });
    sup.start();
    await waitFor(() => sup.recentLog().join("\n").includes("Fully synced"));
    sup.noteLocalChange();
    writeFileSync(signal, "1");
    await waitFor(() => sup.recentLog().join("\n").includes("Upload complete"));
    await new Promise((r) => setTimeout(r, 400));
    expect(sup.recentLog().join("\n")).not.toContain("was not uploaded");
    expect(sup.status().state).toBe("running");
    await sup.shutdown();
  });

  test("a local change during the startup scan does not restart", async () => {
    const bin = fakeOb(`echo "Connection successful. Detecting changes..."\nsleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), settings, { uploadStallMs: 150, connectStallMs: 30_000 });
    sup.start();
    await waitFor(() => sup.recentLog().join("\n").includes("Connection successful"));
    sup.noteLocalChange();
    await new Promise((r) => setTimeout(r, 400));
    expect(sup.recentLog().join("\n")).not.toContain("was not uploaded");
    expect(sup.status().state).toBe("running");
    await sup.shutdown();
  });

  test("restarts when ob stays on Connecting", async () => {
    const bin = fakeOb(`echo "Connecting..."\nsleep 60`);
    const sup = new SyncSupervisor(makeConfig(bin), settings, { uploadStallMs: 30_000, connectStallMs: 200 });
    sup.start();
    await waitFor(() => sup.recentLog().join("\n").includes("stuck connecting"), 2000);
    expect(sup.status().lastError).toContain("stuck connecting");
    expect(sup.status().restartAttempts).toBeGreaterThanOrEqual(1);
    await sup.shutdown();
  });

  test("ignores local changes while sync is stopped", () => {
    const sup = new SyncSupervisor(makeConfig("/nonexistent/ob"), settings, { uploadStallMs: 50 });
    sup.noteLocalChange();
    expect(sup.status().restartAttempts).toBe(0);
    expect(sup.status().state).toBe("idle");
  });
});
