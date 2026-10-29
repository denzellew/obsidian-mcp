import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Config } from "./config.ts";
import { createMcpServer } from "./mcp/server.ts";
import {
  hostGuard,
  mcpOriginGuard,
  rateLimit,
  requireBearer,
  requireSession,
  resolveOriginMiddleware,
  securityHeaders,
  type AuthEnv,
} from "./auth/middleware.ts";
import { abortRegistry, hashToken } from "./auth/tokens.ts";
import { oauthInteractiveRouter, oauthPublicRouter, wellKnownRouter } from "./oauth/router.ts";
import { setupRouter, type SetupState } from "./web/routes/setup.tsx";
import { loginRouter } from "./web/routes/login.tsx";
import { tokensRouter } from "./web/routes/tokens.tsx";
import { passkeysRouter } from "./web/routes/passkeys.tsx";
import { connectionsRouter } from "./web/routes/connections.tsx";
import { dashboardRouter } from "./web/routes/dashboard.tsx";
import { syncRouter } from "./web/routes/sync.tsx";
import { snapshotsRouter } from "./web/routes/snapshots.tsx";
import { auditRouter } from "./web/routes/audit.tsx";
import { guidanceRouter } from "./web/routes/guidance.tsx";
import { recordMcpCall } from "./audit.ts";
import type { VaultRegistry } from "./vaults/registry.ts";

export interface AppDeps {
  config: Config;
  db: Database;
  vaults: VaultRegistry;
  setupState: SetupState;
}

export type AppEnv = AuthEnv & {
  Variables: AuthEnv["Variables"] & {
    deps: AppDeps;
  };
};

export function createApp(deps: AppDeps) {
  const { config, db } = deps;
  const vault = deps.vaults.default();
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", securityHeaders());
  app.use("*", resolveOriginMiddleware(config));
  app.use("*", hostGuard(db, config));

  // CSRF: a request is same-origin when its Origin header matches this
  // request's resolved public origin (works in fixed and derived modes).
  const sameOriginCsrf = csrf({ origin: (origin, c) => origin === c.get("publicOrigin") });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/assets/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }));

  // --- OAuth metadata + public endpoints ---
  app.route("/.well-known", wellKnownRouter(deps.vaults));
  app.use("/oauth/token", rateLimit("oauth", 30));
  app.use("/oauth/register", rateLimit("oauth", 30));
  app.route("/oauth", oauthPublicRouter(db, deps.vaults));

  // --- OAuth interactive (passkey session + consent) ---
  app.use("/oauth/authorize", requireSession(db, { redirect: true }));
  app.use("/oauth/consent", requireSession(db, { redirect: true }), sameOriginCsrf);
  app.route("/oauth", oauthInteractiveRouter(db, deps.vaults));

  // --- Setup & login ---
  app.use("/setup/*", rateLimit("setup", 10));
  app.use("/setup", rateLimit("setup", 10));
  app.route("/setup", setupRouter(db, config, deps.setupState));
  app.use("/login/*", rateLimit("login", 10));
  app.use("/logout", sameOriginCsrf);
  app.route("/", loginRouter(db, config));

  // --- MCP endpoints (bearer auth, one per vault) ---
  // /mcp is the default vault's original endpoint, kept so existing clients keep working.
  const serveMcp = async (c: Context<AppEnv>) => {
    const transport = new StreamableHTTPTransport();
    const principal = c.var.principal!;
    const server = createMcpServer(c.var.vault!.ctx, {
      onToolCall: (tool, args, result) =>
        recordMcpCall(
          db,
          principal,
          tool,
          args,
          result.isError ? "error" : "ok",
          result.isError ? firstText(result) : undefined,
        ),
    });
    await server.connect(transport);
    // revoking the token kills any live SSE stream for it immediately
    const token = c.var.bearerToken!;
    const unregister = abortRegistry.register(hashToken(token), () => void transport.close());
    transport.onclose = unregister;
    return transport.handleRequest(c);
  };
  app.use("/mcp", (c, next) => (c.set("vault", vault), next()), mcpOriginGuard(), requireBearer(db));
  app.all("/mcp", serveMcp);
  app.use(
    "/v/:slug/mcp",
    async (c, next) => {
      const slug = c.req.param("slug") ?? "";
      const target = deps.vaults.get(slug);
      if (!target) return c.json({ error: "not_found", error_description: `No vault '${slug}' on this server` }, 404);
      c.set("vault", target);
      return next();
    },
    mcpOriginGuard(),
    requireBearer(db),
  );
  app.all("/v/:slug/mcp", serveMcp);

  // --- Management UI (session + CSRF) ---
  app.use("/app/*", requireSession(db, { redirect: true }), csrf({ origin: config.origin }));
  app.use("/app", requireSession(db, { redirect: true }));
  app.route("/app/tokens", tokensRouter(db, config));
  app.route("/app/passkeys", passkeysRouter(db, config));
  app.route("/app/connections", connectionsRouter(db));
  app.route("/app/audit", auditRouter(db));
  app.route("/app/guidance", guidanceRouter(db, vault.settings));
  if (vault.sync) app.route("/app/sync", syncRouter(db, vault.config, vault.sync, vault.settings));
  app.route("/app/snapshots", snapshotsRouter(vault.ctx, db));
  app.route("/app", dashboardRouter(deps));

  app.get("/", (c) => c.redirect("/app"));

  return app;
}

/** First line of a tool result's text content, for the audit detail column. */
function firstText(result: { content?: { type: string; text?: string }[] }): string | undefined {
  const block = result.content?.find((b) => b.type === "text");
  return block?.text?.split("\n")[0]?.slice(0, 200);
}
