import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listAudit, categorize, type AuditEntry, type AuditCategory, type AuditSource } from "../../audit.ts";

const BADGE: Record<AuditCategory, string> = {
  read: "bg-base-700 text-text-muted",
  session: "bg-base-700 text-text-muted",
  create: "bg-success/20 text-success",
  edit: "bg-warning/20 text-warning",
  config: "bg-warning/20 text-warning",
  move: "bg-accent/25 text-accent-hover",
  auth: "bg-accent/25 text-accent-hover",
  delete: "bg-danger/20 text-danger",
  daily: "bg-accent-muted/40 text-accent-hover",
  other: "bg-base-700 text-text-muted",
};

const SOURCE_LABEL: Record<AuditSource, string> = { agent: "agent", security: "security", config: "config" };
const SOURCE_DOT: Record<AuditSource, string> = {
  agent: "text-accent-hover",
  security: "text-danger",
  config: "text-warning",
};

const TABS: { key: string; label: string; source?: AuditSource }[] = [
  { key: "all", label: "All" },
  { key: "agent", label: "Agent", source: "agent" },
  { key: "security", label: "Security", source: "security" },
  { key: "config", label: "Config", source: "config" },
];

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
        const cat = categorize(e.source, e.event, e.action);
        return (
          <tr class="border-b border-base-800 align-top">
            <td class="whitespace-nowrap py-2 pr-4 text-text-muted">{when(e.ts)}</td>
            <td class="py-2 pr-3" title={`source: ${e.source}`}>
              <span class={`text-xs ${SOURCE_DOT[e.source]}`}>●</span>{" "}
              <span class="text-xs text-text-muted">{SOURCE_LABEL[e.source]}</span>
            </td>
            <td class="py-2 pr-4">
              <span class={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[cat]}`}>{e.action ?? e.event}</span>
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

function AuditTable(props: { entries: AuditEntry[]; tab: string }) {
  const last = props.entries[props.entries.length - 1];
  return (
    <div id="audit-table">
      {props.entries.length === 0 ? (
        <p class="text-sm text-text-muted">No activity recorded yet.</p>
      ) : (
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-base-700 text-left text-text-muted">
              <th class="py-2 pr-4 font-medium">When</th>
              <th class="py-2 pr-3 font-medium">Source</th>
              <th class="py-2 pr-4 font-medium">Action</th>
              <th class="py-2 pr-4 font-medium">Target</th>
              <th class="py-2 pr-4 font-medium">Actor</th>
              <th class="py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            <Rows entries={props.entries} />
          </tbody>
        </table>
      )}
      {props.entries.length >= 100 && last ? (
        <button
          hx-get={`/app/audit/more?tab=${props.tab}&beforeId=${last.id}`}
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

function sourceForTab(tab: string): AuditSource | undefined {
  return TABS.find((t) => t.key === tab)?.source;
}

export function auditRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "all";
    const entries = listAudit(db, { limit: 100, source: sourceForTab(tab) });
    return c.html(
      <Layout title="Activity" activeNav="/app/audit">
        <div class="space-y-6">
          <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold">Activity</h1>
            <div class="flex gap-2 text-sm">
              {TABS.map((t) => (
                <a
                  href={t.key === "all" ? "/app/audit" : `/app/audit?tab=${t.key}`}
                  class={`rounded-md px-3 py-1.5 ${tab === t.key ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"}`}
                >
                  {t.label}
                </a>
              ))}
            </div>
          </div>
          <p class="text-sm text-text-muted">
            Every action against this server — <span class="text-accent-hover">agent</span> tool calls over MCP,{" "}
            <span class="text-danger">security</span> changes (logins, passkeys, tokens, connections), and{" "}
            <span class="text-warning">config</span> changes (sync, guidance, restores).
          </p>
          <Card>
            <AuditTable entries={entries} tab={tab} />
          </Card>
        </div>
      </Layout>,
    );
  });

  app.get("/more", (c) => {
    const tab = c.req.query("tab") ?? "all";
    const beforeId = Number.parseInt(c.req.query("beforeId") ?? "", 10) || undefined;
    const entries = listAudit(db, { limit: 100, beforeId, source: sourceForTab(tab) });
    return c.html(<AuditTable entries={entries} tab={tab} />);
  });

  return app;
}
