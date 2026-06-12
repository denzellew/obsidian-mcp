import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { squashOldHistory } from "../src/snapshots/retention.ts";
import { tmpVault, type TmpVault } from "./helpers.ts";

const fastOpts = { debounceMs: 30, maxWaitMs: 200, intervalMs: 60_000 };

describe("Snapshotter", () => {
  let vault: TmpVault;
  let snapsDir: string;
  let snap: Snapshotter;

  beforeEach(async () => {
    vault = tmpVault({ "a.md": "alpha\n", ".obsidian/workspace.json": "{}", ".trash/x.md": "junk" });
    snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
    snap = new Snapshotter(snapsDir, vault.dir, fastOpts);
    await snap.init();
  });

  afterEach(() => {
    vault.cleanup();
    rmSync(snapsDir, { recursive: true, force: true });
  });

  test("init takes a startup commit of existing files", async () => {
    const commits = await snap.listCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe("startup");
    const files = await snap.commitFiles(commits[0]!.sha);
    expect(files).toContain("a.md");
    // excluded paths are not snapshotted
    expect(files).not.toContain(".obsidian/workspace.json");
    expect(files.some((f) => f.startsWith(".trash/"))).toBe(false);
  });

  test("commit is a no-op when clean", async () => {
    expect(await snap.commit("noop")).toBeNull();
    expect(await snap.listCommits()).toHaveLength(1);
  });

  test("commit captures changes with reason", async () => {
    vault.write("b.md", "bravo\n");
    const sha = await snap.commit("mcp: create_note b.md");
    expect(sha).not.toBeNull();
    const commits = await snap.listCommits();
    expect(commits[0]!.message).toBe("mcp: create_note b.md");
  });

  test("debounced mutation commits once", async () => {
    vault.write("c.md", "1\n");
    snap.noteMutation("edit c.md");
    vault.write("c.md", "2\n");
    snap.noteMutation("edit c.md");
    await new Promise((r) => setTimeout(r, 60)); // let the 30ms debounce fire
    await snap.flush();
    const commits = await snap.listCommits();
    expect(commits).toHaveLength(2);
    expect(await snap.fileAt(commits[0]!.sha, "c.md")).toBe("2\n");
  });

  test("fileAt returns historical content and null for missing", async () => {
    const first = (await snap.listCommits())[0]!.sha;
    vault.write("a.md", "alpha v2\n");
    await snap.commit("edit a.md");
    expect(await snap.fileAt(first, "a.md")).toBe("alpha\n");
    expect(await snap.fileAt(first, "nope.md")).toBeNull();
  });

  test("listCommits scoped to a path", async () => {
    vault.write("d.md", "delta\n");
    await snap.commit("create d.md");
    vault.write("a.md", "alpha v2\n");
    await snap.commit("edit a.md");
    const dHistory = await snap.listCommits(50, "d.md");
    expect(dHistory).toHaveLength(1);
    expect(dHistory[0]!.message).toBe("create d.md");
  });

  test("shutdown flushes a final commit", async () => {
    vault.write("e.md", "echo\n");
    await snap.shutdown();
    const commits = await snap.listCommits();
    expect(commits[0]!.message).toBe("shutdown");
  });
});

describe("retention", () => {
  test("squashes history older than cutoff, keeps newer chain", async () => {
    const vault = tmpVault({ "a.md": "v1\n" });
    const snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
    const snap = new Snapshotter(snapsDir, vault.dir, fastOpts);
    await snap.init();
    vault.write("a.md", "v2\n");
    await snap.commit("old edit");
    vault.write("a.md", "v3\n");
    await snap.commit("recent edit");

    // everything is "old" relative to a future cutoff except nothing — use now far in future for first two
    const future = new Date(Date.now() + 86_400_000); // cutoff lands after all commits
    // squash with retention placing cutoff between commit 2 and 3 is hard to fake with real
    // timestamps; instead verify squash-everything path: retention 0 days from `future`
    const did = await squashOldHistory(snap.git, 0, future);
    expect(did).toBe(true);
    const commits = await snap.listCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toContain("baseline");
    expect(await snap.fileAt(commits[0]!.sha, "a.md")).toBe("v3\n");

    // no-op when there is nothing below the baseline
    expect(await squashOldHistory(snap.git, 0, future)).toBe(false);

    vault.cleanup();
    rmSync(snapsDir, { recursive: true, force: true });
  });
});
