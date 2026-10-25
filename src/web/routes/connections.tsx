import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listConnections, createConfidentialClient, revokeClient, type ConnectionRow } from "../../oauth/router.ts";
import { isRegistrableRedirectUri } from "../../oauth/policy.ts";
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
              <p class="font-mono text-xs text-text-muted">{conn.client_id}</p>
              <p class="text-xs text-text-muted">
                {conn.client_secret_hash ? "Confidential · " : ""}
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

function NewClientResult(props: { clientId: string; secret: string; redirectUri: string }) {
  return (
    <div class="mt-4 rounded-md border border-accent/40 bg-base-950 p-4">
      <p class="mb-2 text-sm">Copy these now. The secret is shown only once.</p>
      <p class="text-xs text-text-muted">Client ID</p>
      <code class="mb-3 block select-all break-all rounded bg-base-800 p-3 font-mono text-sm">{props.clientId}</code>
      <p class="text-xs text-text-muted">Client secret</p>
      <code class="mb-3 block select-all break-all rounded bg-base-800 p-3 font-mono text-sm text-accent-hover">{props.secret}</code>
      <p class="text-xs text-text-muted">
        Redirect URI <span class="font-mono">{props.redirectUri}</span>
      </p>
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
          <Card title="Add a confidential client">
            <p class="mb-3 text-sm text-text-muted">
              For a provider that asks for a client id and secret. Paste its redirect URI exactly.
            </p>
            <form hx-post="/app/connections" hx-target="#new-client-result" hx-swap="innerHTML" class="space-y-3">
              <input
                type="text"
                name="name"
                required
                placeholder="Name, e.g. Cloudflare"
                class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
              <input
                type="url"
                name="redirect_uri"
                required
                placeholder="https://example.com/callback"
                class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
              />
              <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
                Create
              </button>
            </form>
            <div id="new-client-result"></div>
          </Card>
          <Card title="Approved clients">
            <div id="connection-list">
              <ConnectionList connections={listConnections(db)} />
            </div>
          </Card>
        </div>
      </Layout>,
    ),
  );

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim().slice(0, 100);
    const redirectUri = String(body.redirect_uri ?? "").trim();
    if (!name) return c.html(<p class="mt-3 text-sm text-danger">Name is required.</p>);
    if (!isRegistrableRedirectUri(redirectUri)) {
      return c.html(<p class="mt-3 text-sm text-danger">Redirect URI must be https://, or http:// on localhost.</p>);
    }
    const { clientId, secret } = createConfidentialClient(db, name, redirectUri);
    recordAdmin(db, "oauth.client.create", { target: name });
    return c.html(
      <>
        <NewClientResult clientId={clientId} secret={secret} redirectUri={redirectUri} />
        <div hx-get="/app/connections/list" hx-trigger="load" hx-target="#connection-list" hx-swap="innerHTML"></div>
      </>,
    );
  });

  app.get("/list", (c) => c.html(<ConnectionList connections={listConnections(db)} />));

  app.delete("/:clientId", (c) => {
    const clientId = decodeURIComponent(c.req.param("clientId"));
    const name = listConnections(db).find((conn) => conn.client_id === clientId)?.client_name ?? clientId;
    revokeClient(db, clientId);
    recordAdmin(db, "oauth.revoke", { target: name });
    return c.html(<ConnectionList connections={listConnections(db)} />);
  });

  return app;
}
