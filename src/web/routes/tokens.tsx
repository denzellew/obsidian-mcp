import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { createApiToken, listApiTokens, revokeApiToken, type ApiTokenRow } from "../../auth/tokens.ts";
import { recordAdmin } from "../../audit.ts";

function ago(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function TokenTable(props: { tokens: ApiTokenRow[] }) {
  const active = props.tokens.filter((t) => !t.revoked_at);
  if (active.length === 0) {
    return <p class="text-sm text-text-muted">No tokens yet. Create one to connect Claude Code or another MCP client.</p>;
  }
  return (
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-base-700 text-left text-text-muted">
          <th class="py-2 pr-4 font-medium">Name</th>
          <th class="py-2 pr-4 font-medium">Token</th>
          <th class="py-2 pr-4 font-medium">Created</th>
          <th class="py-2 pr-4 font-medium">Last used</th>
          <th class="py-2"></th>
        </tr>
      </thead>
      <tbody>
        {active.map((t) => (
          <tr class="border-b border-base-800">
            <td class="py-2 pr-4">{t.name}</td>
            <td class="py-2 pr-4 font-mono text-text-muted">{t.token_prefix}…</td>
            <td class="py-2 pr-4 text-text-muted">{ago(t.created_at)}</td>
            <td class="py-2 pr-4 text-text-muted">{ago(t.last_used_at)}</td>
            <td class="py-2 text-right">
              <button
                hx-delete={`/app/tokens/${t.id}`}
                hx-confirm={`Revoke '${t.name}'? Clients using it lose access immediately.`}
                hx-target="#token-list"
                class="text-sm text-danger hover:underline"
              >
                Revoke
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TokensPage(props: { tokens: ApiTokenRow[]; mcpUrl: string }) {
  return (
    <Layout title="Tokens" activeNav="/app/tokens">
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">API tokens</h1>
        <Card title="Create token">
          <form hx-post="/app/tokens" hx-target="#new-token-result" hx-swap="innerHTML" class="flex gap-3">
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Claude Code on laptop"
              class="flex-1 rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
            <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
              Create
            </button>
          </form>
          <div id="new-token-result"></div>
        </Card>
        <Card title="Active tokens">
          <div id="token-list">
            <TokenTable tokens={props.tokens} />
          </div>
        </Card>
        <Card title="Connecting clients">
          <p class="mb-2 text-sm text-text-muted">Claude Code:</p>
          <pre class="overflow-x-auto rounded-md bg-base-950 p-3 font-mono text-xs text-text-muted">{`claude mcp add --transport http obsidian ${props.mcpUrl} \\
  --header "Authorization: Bearer <token>"`}</pre>
          <p class="mt-3 text-sm text-text-muted">
            Claude Desktop / claude.ai: add a custom connector with URL <span class="font-mono">{props.mcpUrl}</span> — it
            uses OAuth and will redirect here for passkey approval; no token needed.
          </p>
        </Card>
      </div>
    </Layout>
  );
}

function NewTokenResult(props: { token: string; name: string }) {
  return (
    <div class="mt-4 rounded-md border border-accent/40 bg-base-950 p-4">
      <p class="mb-2 text-sm">
        Token <span class="font-semibold">{props.name}</span> created. Copy it now — it is shown only once:
      </p>
      <code class="block select-all break-all rounded bg-base-800 p-3 font-mono text-sm text-accent-hover">{props.token}</code>
    </div>
  );
}

export function tokensRouter(db: Database, config: Config): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => c.html(<TokensPage tokens={listApiTokens(db)} mcpUrl={`${c.var.publicOrigin}/mcp`} />));

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim().slice(0, 100);
    if (!name) return c.html(<p class="mt-3 text-sm text-danger">Name is required.</p>);
    const { token } = createApiToken(db, name);
    recordAdmin(db, "token.create", { target: name });
    c.header("HX-Trigger", "tokenCreated");
    return c.html(
      <>
        <NewTokenResult token={token} name={name} />
        <div hx-get="/app/tokens/list" hx-trigger="load" hx-target="#token-list" hx-swap="innerHTML"></div>
      </>,
    );
  });

  app.get("/list", (c) => c.html(<TokenTable tokens={listApiTokens(db)} />));

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const name = listApiTokens(db).find((t) => t.id === id)?.name ?? id;
    if (revokeApiToken(db, id)) recordAdmin(db, "token.revoke", { target: name });
    return c.html(<TokenTable tokens={listApiTokens(db)} />);
  });

  return app;
}
