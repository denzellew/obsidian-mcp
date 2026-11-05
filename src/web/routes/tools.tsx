import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { VaultContext } from "../../mcp/context.ts";
import { buildInstructions, createMcpServer } from "../../mcp/server.ts";

const USAGE_WINDOW_DAYS = 30;

// The tool set is fixed per process, so ask once. Going through a real
// client (not server internals) means this page shows exactly what an MCP
// client sees, and new tools appear here without touching this file.
let toolsCache: Promise<Tool[]> | null = null;

export function listMcpTools(ctx: VaultContext): Promise<Tool[]> {
  toolsCache ??= (async () => {
    const server = createMcpServer(ctx);
    const client = new Client({ name: "obsidian-mcp-ui", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      return (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await client.close();
      await server.close();
    }
  })().catch((err) => {
    toolsCache = null; // don't cache a failure
    throw err;
  });
  return toolsCache;
}

interface Usage {
  event: string;
  calls: number;
  errors: number;
  last_ts: number;
}

function usageByTool(db: Database, vaultId: number): Map<string, Usage> {
  const since = Math.floor(Date.now() / 1000) - USAGE_WINDOW_DAYS * 86400;
  const rows = db
    .query<Usage, [number, number]>(
      `SELECT event, COUNT(*) AS calls, SUM(status = 'error') AS errors, MAX(ts) AS last_ts
       FROM audit_log WHERE source = 'agent' AND vault_id = ? AND ts >= ? GROUP BY event`,
    )
    .all(vaultId, since);
  return new Map(rows.map((r) => [r.event, r]));
}

function ago(unix: number): string {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface JsonSchemaProp {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  items?: JsonSchemaProp;
  anyOf?: JsonSchemaProp[];
  oneOf?: JsonSchemaProp[];
}

function typeOf(p: JsonSchemaProp): string {
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(" | ");
  const alts = p.anyOf ?? p.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].join(" | ");
  if (p.type === "array") return p.items ? `${typeOf(p.items)}[]` : "array";
  if (Array.isArray(p.type)) return p.type.join(" | ");
  return p.type ?? "any";
}

function Badge(props: { kind: "read" | "write" | "destructive" }) {
  const styles = {
    read: "bg-success/15 text-success",
    write: "bg-accent-muted/40 text-accent-hover",
    destructive: "bg-danger/15 text-danger",
  } as const;
  const label = { read: "read-only", write: "writes", destructive: "destructive" } as const;
  return <span class={`rounded px-2 py-0.5 text-xs font-medium ${styles[props.kind]}`}>{label[props.kind]}</span>;
}

function ToolCard(props: { tool: Tool; usage?: Usage }) {
  const { tool, usage } = props;
  const kind = tool.annotations?.readOnlyHint ? "read" : tool.annotations?.destructiveHint ? "destructive" : "write";
  const params = Object.entries((tool.inputSchema.properties ?? {}) as Record<string, JsonSchemaProp>);
  const required = new Set(tool.inputSchema.required ?? []);
  return (
    <div id={`tool-${tool.name}`} class="rounded-md border border-base-700 bg-base-950 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono font-medium">{tool.name}</span>
        {tool.title ? <span class="text-sm text-text-muted">{tool.title}</span> : null}
        <Badge kind={kind} />
        <span class="ml-auto text-xs text-text-muted">
          {usage
            ? `${usage.calls} call${usage.calls === 1 ? "" : "s"}${usage.errors ? ` · ${usage.errors} error${usage.errors === 1 ? "" : "s"}` : ""} · last ${ago(usage.last_ts)}`
            : `unused in ${USAGE_WINDOW_DAYS}d`}
        </span>
      </div>
      {tool.description ? <p class="mt-2 text-sm leading-relaxed text-text-muted">{tool.description}</p> : null}
      {params.length ? (
        <details class="mt-3">
          <summary class="cursor-pointer text-sm text-accent-hover">
            {params.length} parameter{params.length === 1 ? "" : "s"}
          </summary>
          <table class="mt-2 w-full text-sm">
            <tbody>
              {params.map(([name, p]) => (
                <tr class="border-t border-base-800 align-top">
                  <td class="py-1.5 pr-3 font-mono whitespace-nowrap">
                    {name}
                    {required.has(name) ? <span class="text-danger" title="required">*</span> : null}
                  </td>
                  <td class="py-1.5 pr-3 font-mono text-xs text-text-muted">{typeOf(p)}</td>
                  <td class="py-1.5 text-text-muted">
                    {p.description ?? ""}
                    {p.default !== undefined ? <span class="ml-1 font-mono text-xs">(default {JSON.stringify(p.default)})</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

export function toolsRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const vault = c.var.vault!;
    const tools = await listMcpTools(vault.ctx);
    const usage = usageByTool(db, vault.id);
    const counts = {
      read: tools.filter((t) => t.annotations?.readOnlyHint).length,
      destructive: tools.filter((t) => !t.annotations?.readOnlyHint && t.annotations?.destructiveHint).length,
    };
    return c.html(
      <Layout title="Tools" activeNav="/app/tools">
        <div class="space-y-6">
          <div>
            <h1 class="text-xl font-semibold">MCP tools</h1>
            <p class="mt-1 text-sm text-text-muted">
              {tools.length} tools available to clients connected to <span class="text-text">{vault.name}</span>:{" "}
              {counts.read} read-only, {tools.length - counts.read - counts.destructive} that write, {counts.destructive} destructive.
              Usage covers the last {USAGE_WINDOW_DAYS} days.
            </p>
          </div>
          <Card title="Tools">
            <div class="space-y-3">
              {tools.map((t) => (
                <ToolCard tool={t} usage={usage.get(t.name)} />
              ))}
            </div>
          </Card>
          <Card title="Server instructions">
            <p class="mb-2 text-sm text-text-muted">
              Sent to every client when it connects, alongside the tool list (includes the vault's AGENTS.md and your guidance).
            </p>
            <pre class="overflow-x-auto rounded-md bg-base-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-text-muted">
              {buildInstructions(vault.ctx)}
            </pre>
          </Card>
        </div>
      </Layout>,
    );
  });

  return app;
}
