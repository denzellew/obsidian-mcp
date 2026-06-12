import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Config } from "./config.ts";
import type { VaultContext } from "./mcp/context.ts";
import { createMcpServer } from "./mcp/server.ts";
import {
  hostGuard,
  mcpOriginGuard,
  rateLimit,
  requireBearer,
  requireSession,
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
import type { SyncSupervisor } from "./sync/supervisor.ts";

export interface AppDeps {
  config: Config;
  db: Database;
  vaultCtx: VaultContext;
  setupState: SetupState;
  sync?: SyncSupervisor;
}

export type AppEnv = AuthEnv & {
  Variables: AuthEnv["Variables"] & {
    deps: AppDeps;
  };
};

export function createApp(deps: AppDeps) {
  const { config, db } = deps;
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", securityHeaders());
  app.use("*", hostGuard(config));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/assets/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }));

  // --- OAuth metadata + public endpoints ---
  app.route("/.well-known", wellKnownRouter(config));
  app.use("/oauth/token", rateLimit("oauth", 30));
  app.use("/oauth/register", rateLimit("oauth", 30));
  app.route("/oauth", oauthPublicRouter(db, config));

  // --- OAuth interactive (passkey session + consent) ---
  app.use("/oauth/authorize", requireSession(db, { redirect: true }));
  app.use("/oauth/consent", requireSession(db, { redirect: true }), csrf({ origin: config.origin }));
  app.route("/oauth", oauthInteractiveRouter(db, config));

  // --- Setup & login ---
  app.use("/setup/*", rateLimit("setup", 10));
  app.use("/setup", rateLimit("setup", 10));
  app.route("/setup", setupRouter(db, config, deps.setupState));
  app.use("/login/*", rateLimit("login", 10));
  app.use("/logout", csrf({ origin: config.origin }));
  app.route("/", loginRouter(db, config));

  // --- MCP endpoint (bearer auth) ---
  app.use("/mcp", mcpOriginGuard(config), requireBearer(db, config));
  app.all("/mcp", async (c) => {
    const transport = new StreamableHTTPTransport();
    const server = createMcpServer(deps.vaultCtx);
    await server.connect(transport);
    // revoking the token kills any live SSE stream for it immediately
    const token = c.var.bearerToken!;
    const unregister = abortRegistry.register(hashToken(token), () => void transport.close());
    transport.onclose = unregister;
    return transport.handleRequest(c);
  });

  // --- Management UI (session + CSRF) ---
  app.use("/app/*", requireSession(db, { redirect: true }), csrf({ origin: config.origin }));
  app.use("/app", requireSession(db, { redirect: true }));
  app.route("/app/tokens", tokensRouter(db, config));
  app.route("/app/passkeys", passkeysRouter(db, config));
  app.route("/app/connections", connectionsRouter(db));
  if (deps.sync) app.route("/app/sync", syncRouter(db, config, deps.sync));
  app.route("/app/snapshots", snapshotsRouter(deps.vaultCtx));
  app.route("/app", dashboardRouter(deps));

  app.get("/", (c) => c.redirect("/app"));

  return app;
}
