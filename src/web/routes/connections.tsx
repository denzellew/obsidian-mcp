import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listConnections, revokeClient, setIdentityLabel, type ConnectionRow } from "../../oauth/router.ts";
import { MAX_LABEL_CHARS, mcpClientLabel, normalizeLabel, redirectHint } from "../../oauth/identity.ts";
import { recordAdmin } from "../../audit.ts";

function ago(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** What the client itself reported, so the owner can tell same-named clients apart. */
function details(conn: ConnectionRow): string {
  const parts = [`registered as "${conn.client_name}"`];
  const hint = redirectHint(conn.redirect_uris);
  if (hint) parts.push(`redirects to ${hint}`);
  const clients = [...new Set(conn.grants.map((g) => mcpClientLabel(g.mcp_client_name, g.mcp_client_version)).filter(Boolean))];
  if (clients.length) parts.push(`MCP client ${clients.join(", ")}`);
  if (conn.software_id) parts.push(`software ${conn.software_id}${conn.software_version ? ` ${conn.software_version}` : ""}`);
  if (conn.client_ids.length > 1) parts.push(`${conn.client_ids.length} registrations, showing the most recent`);
  return parts.join(" · ");
}

function ConnectionList(props: { connections: ConnectionRow[] }) {
  if (props.connections.length === 0) {
    return (
      <p class="text-sm text-text-muted">
        No OAuth connections to this vault yet. Add its MCP URL as a custom connector in Claude Desktop or claude.ai and approve it here.
      </p>
    );
  }
  return (
    <div class="space-y-4">
      {props.connections.map((conn) => {
        const id = encodeURIComponent(conn.client_id);
        return (
          <div class="rounded-md border border-base-700 bg-base-950 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">{conn.display_name}</p>
                <p class="text-xs text-text-muted">{details(conn)}</p>
                <p class="text-xs text-text-muted">
                  Approved {ago(conn.consented_at)} · {conn.grants.length} active grant{conn.grants.length === 1 ? "" : "s"}
                  {conn.grants[0] ? ` · last used ${ago(conn.grants[0].last_used_at)}` : ""}
                </p>
              </div>
              <button
                hx-delete={`/app/connections/${id}`}
                hx-confirm={`Revoke '${conn.display_name}'? It must re-authorize to reconnect.`}
                hx-target="#connection-list"
                class="shrink-0 text-sm text-danger hover:underline"
              >
                Revoke
              </button>
            </div>
            <form hx-put={`/app/connections/${id}/label`} hx-target="#connection-list" class="mt-3 flex gap-2">
              <input
                type="text"
                name="label"
                value={conn.label ?? ""}
                placeholder={conn.label ? "" : `${conn.display_name} (auto)`}
                maxlength={MAX_LABEL_CHARS}
                aria-label="Connection name"
                class="min-w-0 flex-1 rounded-md border border-base-600 bg-base-900 px-2 py-1 text-sm"
              />
              <button type="submit" class="rounded-md border border-base-600 px-3 py-1 text-sm text-text-muted hover:text-text">
                Rename
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}

export function connectionsRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) =>
    c.html(
      <Layout title="Connections" activeNav="/app/connections">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">OAuth connections</h1>
          <Card title="Approved clients">
            <div id="connection-list">
              <ConnectionList connections={listConnections(db, c.var.vault!.id)} />
            </div>
          </Card>
        </div>
      </Layout>,
    ),
  );

  const groupOf = (vaultId: number, clientId: string) =>
    listConnections(db, vaultId).find((conn) => conn.client_ids.includes(clientId));

  // Names the app, not one registration: later re-registrations inherit it.
  // A blank label clears it, falling back to the auto-derived name.
  app.put("/:clientId/label", async (c) => {
    const clientId = decodeURIComponent(c.req.param("clientId"));
    const vaultId = c.var.vault!.id;
    const before = groupOf(vaultId, clientId);
    if (before) {
      const body = await c.req.parseBody();
      const label = normalizeLabel(body.label);
      if (label !== before.label && setIdentityLabel(db, vaultId, before.key, label)) {
        const after = groupOf(vaultId, clientId);
        recordAdmin(db, "oauth.rename", { target: `${before.display_name} → ${after?.display_name ?? label}`, vaultId });
      }
    }
    return c.html(<ConnectionList connections={listConnections(db, vaultId)} />);
  });

  app.delete("/:clientId", (c) => {
    const clientId = decodeURIComponent(c.req.param("clientId"));
    const vaultId = c.var.vault!.id;
    const conn = groupOf(vaultId, clientId);
    if (conn) {
      for (const id of conn.client_ids) revokeClient(db, id, vaultId);
      recordAdmin(db, "oauth.revoke", { target: conn.display_name, vaultId });
    }
    return c.html(<ConnectionList connections={listConnections(db, vaultId)} />);
  });

  return app;
}
