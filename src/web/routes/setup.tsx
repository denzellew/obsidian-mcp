import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout } from "../layout.tsx";
import { SESSION_COOKIE, type AuthEnv } from "../../auth/middleware.ts";
import { safeEqual } from "../../auth/tokens.ts";
import { createSession } from "../../auth/sessions.ts";
import { finishRegistration, passkeyCount, startRegistration } from "../../auth/webauthn.ts";
import { setSetting } from "../../db/index.ts";
import { recordAdmin } from "../../audit.ts";

export interface SetupState {
  /** In-memory only; regenerated each boot until setup completes. */
  token: string | null;
  /** userHandle staged between options and verify (single-user, single-flow). */
  pendingUserHandle: Uint8Array | null;
}

function SetupPage() {
  return (
    <Layout title="Setup" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-base-700 bg-base-900 p-8">
        <div class="mb-6 flex items-center gap-3">
          <img src="/assets/logo.svg" alt="" class="h-8 w-8" />
          <h1 class="text-lg font-semibold">Welcome to Obsidian MCP</h1>
        </div>
        <p class="mb-6 text-sm text-text-muted">
          To claim this server, enter the setup token from the server logs (<span class="font-mono">docker compose logs app</span>)
          and create your first passkey. Passkeys are the only way to sign in.
        </p>
        <form id="setup-form" class="space-y-4">
          <div>
            <label class="mb-1 block text-sm text-text-muted" for="setup-token">Setup token</label>
            <input
              id="setup-token"
              type="text"
              required
              autocomplete="off"
              placeholder="setup_…"
              class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm text-text-muted" for="setup-passkey-name">Passkey name</label>
            <input
              id="setup-passkey-name"
              type="text"
              placeholder="e.g. MacBook Touch ID"
              class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <button type="submit" class="w-full rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover">
            Create passkey
          </button>
          <p id="setup-status" class="hidden text-sm text-text-muted"></p>
        </form>
      </div>
      <script src="/assets/vendor/simplewebauthn-browser.min.js"></script>
      <script src="/assets/auth-client.js"></script>
    </Layout>
  );
}

export function setupRouter(db: Database, config: Config, state: SetupState): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // whole router 404s once a passkey exists
  app.use("*", async (c, next) => {
    if (passkeyCount(db) > 0) return c.notFound();
    return next();
  });

  app.get("/", (c) => c.html(<SetupPage />));

  app.post("/webauthn/options", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = String(body.setupToken ?? "");
    if (!state.token || !token || !safeEqual(token, state.token)) {
      return c.json({ error: "Invalid setup token. Check the server logs for the current token (it changes on restart)." }, 403);
    }
    const { options, challengeId, userHandle } = await startRegistration(db, { rpId: c.var.rpId, origin: c.var.publicOrigin });
    state.pendingUserHandle = userHandle;
    return c.json({ options, challengeId });
  });

  app.post("/webauthn/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = String(body.setupToken ?? "");
    if (!state.token || !token || !safeEqual(token, state.token)) {
      return c.json({ error: "Invalid setup token." }, 403);
    }
    if (!state.pendingUserHandle) return c.json({ error: "No registration in progress — reload and try again." }, 400);
    const result = await finishRegistration(
      db,
      { rpId: c.var.rpId, origin: c.var.publicOrigin },
      body.response,
      body.challengeId,
      String(body.name ?? "").trim() || "First passkey",
      state.pendingUserHandle,
    );
    if ("error" in result) return c.json(result, 400);
    setSetting(db, "setup_complete", "1");
    recordAdmin(db, "setup.complete", { detail: `rpID ${c.var.rpId}` });
    // rp_id_at_setup is pinned inside finishRegistration
    state.token = null;
    state.pendingUserHandle = null;
    const session = createSession(db, 1, c.req.header("user-agent"));
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.var.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
    return c.json({ ok: true });
  });

  return app;
}
