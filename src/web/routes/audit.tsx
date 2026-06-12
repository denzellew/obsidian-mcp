import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listAudit, categorize, type AuditEntry, type AuditCategory } from "../../mcp/audit.ts";

const BADGE: Record<AuditCategory, string> = {
  read: "bg-base-700 text-text-muted",
  create: "bg-success/20 text-success",
  edit: "bg-warning/20 text-warning",
  move: "bg-accent/25 text-accent-hover",
  delete: "bg-danger/20 text-danger",
  daily: "bg-accent-muted/40 text-accent-hover",
  other: "bg-base-700 text-text-muted",
};

function when(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Rows(props: { entries: AuditEntry[] }) {
  return (
    <>
      {props.entries.map((e) => {
        const cat = categorize(e.tool, e.action);
        return (
          <tr class="border-b border-base-800 align-top">
            <td class="whitespace-nowrap py-2 pr-4 text-text-muted">{when(e.ts)}</td>
            <td class="py-2 pr-4">
              <span class={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[cat]}`}>{e.action ?? e.tool}</span>
            </td>
            <td class="py-2 pr-4 font-mono text-xs">{e.target ?? "—"}</td>
            <td class="py-2 pr-4 text-text-muted">{e.actor_name}</td>
            <td class="py-2">
              {e.status === "error" ? (
                <span class="text-danger" title={e.detail ?? ""}>
                  error
                </span>
              ) : (
                <span class="text-success">ok</span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function AuditTable(props: { entries: AuditEntry[]; writesOnly: boolean }) {
  return (
    <div id="audit-table">
      {props.entries.length === 0 ? (
        <p class="text-sm text-text-muted">No MCP activity recorded yet.</p>
      ) : (
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-base-700 text-left text-text-muted">
              <th class="py-2 pr-4 font-medium">When</th>
              <th class="py-2 pr-4 font-medium">Action</th>
              <th class="py-2 pr-4 font-medium">Target</th>
              <th class="py-2 pr-4 font-medium">Client</th>
              <th class="py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            <Rows entries={props.entries} />
          </tbody>
        </table>
      )}
      {props.entries.length >= 100 ? (
        <button
          hx-get={`/app/audit/more?beforeId=${props.entries[props.entries.length - 1]!.id}${props.writesOnly ? "&writes=1" : ""}`}
          hx-target="#audit-table"
          hx-swap="outerHTML"
          class="mt-4 rounded-md border border-base-600 px-4 py-2 text-sm text-text-muted hover:text-text"
        >
          Load older
        </button>
      ) : null}
    </div>
  );
}

export function auditRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const writesOnly = c.req.query("writes") === "1";
    const entries = listAudit(db, { limit: 100, writesOnly });
    return c.html(
      <Layout title="Activity" activeNav="/app/audit">
        <div class="space-y-6">
          <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold">MCP activity</h1>
            <div class="flex gap-2 text-sm">
              <a
                href="/app/audit"
                class={`rounded-md px-3 py-1.5 ${!writesOnly ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"}`}
              >
                All
              </a>
              <a
                href="/app/audit?writes=1"
                class={`rounded-md px-3 py-1.5 ${writesOnly ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"}`}
              >
                Writes only
              </a>
            </div>
          </div>
          <Card>
            <AuditTable entries={entries} writesOnly={writesOnly} />
          </Card>
        </div>
      </Layout>,
    );
  });

  app.get("/more", (c) => {
    const writesOnly = c.req.query("writes") === "1";
    const beforeId = Number.parseInt(c.req.query("beforeId") ?? "", 10) || undefined;
    const entries = listAudit(db, { limit: 100, beforeId, writesOnly });
    return c.html(<AuditTable entries={entries} writesOnly={writesOnly} />);
  });

  return app;
}
