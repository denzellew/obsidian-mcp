import { Hono } from "hono";
import { Layout, Card } from "../layout.tsx";
import type { AppDeps, AppEnv } from "../../app.tsx";
import { isMarkdown } from "../../vault/paths.ts";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function StateBadge(props: { state: string }) {
  const color =
    props.state === "running" ? "bg-success/20 text-success" :
    props.state === "error" ? "bg-danger/20 text-danger" :
    "bg-base-700 text-text-muted";
  return <span class={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{props.state}</span>;
}

export function dashboardRouter(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const { vaultCtx, sync } = deps;
    const publicOrigin = c.var.publicOrigin;
    let notes = 0;
    let attachments = 0;
    for (const f of vaultCtx.store.walkFiles()) {
      if (isMarkdown(f.path)) notes++;
      else attachments++;
    }
    const commits = await vaultCtx.snapshotter.listCommits(5);
    const syncStatus = sync?.status();

    return c.html(
      <Layout title="Dashboard" activeNav="/app">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Dashboard</h1>

          <div class="grid grid-cols-3 gap-4">
            <Card>
              <p class="text-2xl font-semibold">{notes}</p>
              <p class="text-sm text-text-muted">notes</p>
            </Card>
            <Card>
              <p class="text-2xl font-semibold">{attachments}</p>
              <p class="text-sm text-text-muted">attachments</p>
            </Card>
            <Card>
              <p class="text-2xl font-semibold">{commits[0] ? ago(commits[0].date) : "—"}</p>
              <p class="text-sm text-text-muted">last snapshot</p>
            </Card>
          </div>

          <Card title="Obsidian Sync">
            {syncStatus ? (
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <StateBadge state={syncStatus.state} />
                  <span class="text-sm text-text-muted">
                    {syncStatus.state === "idle" && !syncStatus.desired
                      ? "Not configured — set up Obsidian Sync to mirror this vault to your devices."
                      : (syncStatus.lastError ?? "")}
                  </span>
                </div>
                <a href="/app/sync" class="text-sm text-accent-hover hover:underline">
                  Manage →
                </a>
              </div>
            ) : (
              <p class="text-sm text-text-muted">Sync is unavailable.</p>
            )}
          </Card>

          <Card title="MCP endpoint">
            <p class="font-mono text-sm text-text-muted">{publicOrigin}/mcp</p>
            <p class="mt-2 text-sm text-text-muted">
              Connect Claude Desktop via OAuth (just add the URL) or create a bearer token under{" "}
              <a href="/app/tokens" class="text-accent-hover hover:underline">Tokens</a> for Claude Code.
            </p>
          </Card>

          <Card title="Recent snapshots">
            {commits.length === 0 ? (
              <p class="text-sm text-text-muted">No snapshots yet.</p>
            ) : (
              <ul class="space-y-1 text-sm">
                {commits.map((cmt) => (
                  <li class="flex justify-between">
                    <span class="truncate pr-4">{cmt.message}</span>
                    <span class="shrink-0 font-mono text-xs text-text-muted">
                      {cmt.sha.slice(0, 7)} · {ago(cmt.date)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <a href="/app/snapshots" class="mt-3 inline-block text-sm text-accent-hover hover:underline">
              Browse history →
            </a>
          </Card>
        </div>
      </Layout>,
    );
  });

  return app;
}
