import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listConnections, revokeClient, type ConnectionRow } from "../../oauth/router.ts";
import { recordAdmin } from "../../audit.ts";

function ago(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ConnectionList(props: { connections: ConnectionRow[] }) {
  if (props.connections.length === 0) {
    return (
      <p class="text-sm text-text-muted">
        No OAuth connections yet. Add this server as a custom connector in Claude Desktop or claude.ai and approve it here.
      </p>
    );
  }
  return (
    <div class="space-y-4">
      {props.connections.map((conn) => (
        <div class="rounded-md border border-base-700 bg-base-950 p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium">{conn.client_name}</p>
              <p class="text-xs text-text-muted">
                Approved {ago(conn.consented_at)} · {conn.grants.length} active grant{conn.grants.length === 1 ? "" : "s"}
                {conn.grants[0] ? ` · last used ${ago(conn.grants[0].last_used_at)}` : ""}
              </p>
            </div>
            <button
              hx-delete={`/app/connections/${encodeURIComponent(conn.client_id)}`}
              hx-confirm={`Revoke '${conn.client_name}'? It must re-authorize to reconnect.`}
              hx-target="#connection-list"
              class="text-sm text-danger hover:underline"
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
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
              <ConnectionList connections={listConnections(db)} />
            </div>
          </Card>
        </div>
      </Layout>,
    ),
  );

  app.delete("/:clientId", (c) => {
    const clientId = decodeURIComponent(c.req.param("clientId"));
    const name = listConnections(db).find((conn) => conn.client_id === clientId)?.client_name ?? clientId;
    revokeClient(db, clientId);
    recordAdmin(db, "oauth.revoke", { target: name });
    return c.html(<ConnectionList connections={listConnections(db)} />);
  });

  return app;
}
