import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { VaultContext } from "../../mcp/context.ts";
import { safePath } from "../../vault/paths.ts";
import { recordAdmin } from "../../audit.ts";

function ago(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function snapshotsRouter(ctx: VaultContext, db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const path = c.req.query("path");
    const commits = await ctx.snapshotter.listCommits(50, path || undefined);
    return c.html(
      <Layout title="Snapshots" activeNav="/app/snapshots">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Vault snapshots</h1>
          <Card>
            <form method="get" action="/app/snapshots" class="flex gap-3">
              <input
                type="text"
                name="path"
                value={path ?? ""}
                placeholder="Filter by file, e.g. Projects/Home Lab.md"
                class="flex-1 rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
              <button type="submit" class="rounded-md border border-base-600 px-4 py-2 text-sm text-text-muted hover:text-text">
                Filter
              </button>
            </form>
          </Card>
          <Card title={path ? `History of ${path}` : "Recent snapshots"}>
            {commits.length === 0 ? (
              <p class="text-sm text-text-muted">No snapshots{path ? ` touching ${path}` : ""} yet.</p>
            ) : (
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-base-700 text-left text-text-muted">
                    <th class="py-2 pr-4 font-medium">When</th>
                    <th class="py-2 pr-4 font-medium">Reason</th>
                    <th class="py-2 pr-4 font-medium">Commit</th>
                    <th class="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((cmt) => (
                    <tr class="border-b border-base-800 align-top">
                      <td class="py-2 pr-4 whitespace-nowrap text-text-muted">{ago(cmt.date)}</td>
                      <td class="py-2 pr-4">{cmt.message}</td>
                      <td class="py-2 pr-4 font-mono text-xs text-text-muted">{cmt.sha.slice(0, 7)}</td>
                      <td class="py-2 text-right">
                        <a href={`/app/snapshots/${cmt.sha}`} class="text-accent-hover hover:underline">
                          files
                        </a>
                        {path ? (
                          <>
                            {" · "}
                            <a href={`/app/snapshots/${cmt.sha}/file?path=${encodeURIComponent(path)}`} class="text-accent-hover hover:underline">
                              view
                            </a>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card>
            <p class="text-xs text-text-muted">
              Snapshots are plain git commits in <span class="font-mono">data/snapshots/vault.git</span> — for full
              restores or diffs, use git directly:{" "}
              <span class="font-mono">git --git-dir data/snapshots/vault.git --work-tree data/Vault log</span>
            </p>
          </Card>
        </div>
      </Layout>,
    );
  });

  app.get("/:sha", async (c) => {
    const sha = c.req.param("sha");
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return c.notFound();
    const files = await ctx.snapshotter.commitFiles(sha);
    return c.html(
      <Layout title="Snapshot" activeNav="/app/snapshots">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">
            Snapshot <span class="font-mono text-base text-text-muted">{sha.slice(0, 7)}</span>
          </h1>
          <Card title="Files changed">
            {files.length === 0 ? (
              <p class="text-sm text-text-muted">No file changes recorded.</p>
            ) : (
              <ul class="space-y-1 text-sm">
                {files.map((f) => (
                  <li>
                    <a href={`/app/snapshots/${sha}/file?path=${encodeURIComponent(f)}`} class="text-accent-hover hover:underline">
                      {f}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <a href="/app/snapshots" class="text-sm text-text-muted hover:text-text">← Back to snapshots</a>
        </div>
      </Layout>,
    );
  });

  app.get("/:sha/file", async (c) => {
    const sha = c.req.param("sha");
    const path = c.req.query("path") ?? "";
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !path) return c.notFound();
    const content = await ctx.snapshotter.fileAt(sha, path);
    return c.html(
      <Layout title={`${path} @ ${sha.slice(0, 7)}`} activeNav="/app/snapshots">
        <div class="space-y-6">
          <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold">
              {path} <span class="font-mono text-sm text-text-muted">@ {sha.slice(0, 7)}</span>
            </h1>
            {content !== null ? (
              <form method="post" action={`/app/snapshots/${sha}/restore`}>
                <input type="hidden" name="path" value={path} />
                <button
                  type="submit"
                  class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  Restore this version
                </button>
              </form>
            ) : null}
          </div>
          <Card>
            {content === null ? (
              <p class="text-sm text-text-muted">This file did not exist at this snapshot (or is binary).</p>
            ) : (
              <pre class="max-h-[32rem] overflow-auto rounded-md bg-base-950 p-4 font-mono text-xs leading-relaxed text-text">{content}</pre>
            )}
          </Card>
          <a href={`/app/snapshots?path=${encodeURIComponent(path)}`} class="text-sm text-text-muted hover:text-text">
            ← History of this file
          </a>
        </div>
      </Layout>,
    );
  });

  app.post("/:sha/restore", async (c) => {
    const sha = c.req.param("sha");
    const body = await c.req.parseBody();
    const path = safePath(String(body.path ?? ""));
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !path) return c.notFound();
    const content = await ctx.snapshotter.fileAt(sha, path);
    if (content === null) return c.text("Version not found", 404);
    // restoring writes through the normal store path, so it becomes a NEW
    // snapshot — history is never rewritten
    await ctx.store.write(path, content);
    await ctx.snapshotter.commit(`restore: ${path} from ${sha.slice(0, 7)}`);
    recordAdmin(db, "snapshot.restore", { target: path, detail: `from ${sha.slice(0, 7)}` });
    return c.redirect(`/app/snapshots?path=${encodeURIComponent(path)}`);
  });

  return app;
}
