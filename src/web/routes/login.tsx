import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout } from "../layout.tsx";
import { SESSION_COOKIE, safeReturnTo, type AuthEnv } from "../../auth/middleware.ts";
import { createSession, deleteSession } from "../../auth/sessions.ts";
import { finishAuthentication, passkeyCount, startAuthentication } from "../../auth/webauthn.ts";
import { recordAdmin } from "../../audit.ts";
import { clientIp } from "../../auth/middleware.ts";

function LoginPage(props: { returnTo: string }) {
  return (
    <Layout title="Sign in" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-base-700 bg-base-900 p-8 text-center">
        <img src="/assets/logo.svg" alt="" class="mx-auto mb-4 h-12 w-12" />
        <h1 class="mb-2 text-lg font-semibold">Obsidian MCP</h1>
        <p class="mb-6 text-sm text-text-muted">Sign in with your passkey to manage this server.</p>
        <input type="hidden" id="login-return-to" value={props.returnTo} />
        <button
          id="login-button"
          class="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-hover"
        >
          Sign in with passkey
        </button>
        <p id="login-status" class="mt-4 hidden text-sm text-text-muted"></p>
      </div>
      <script src="/assets/vendor/simplewebauthn-browser.min.js"></script>
      <script src="/assets/auth-client.js"></script>
    </Layout>
  );
}

export function loginRouter(db: Database, config: Config): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/login", (c) => {
    if (passkeyCount(db) === 0) return c.redirect("/setup");
    return c.html(<LoginPage returnTo={safeReturnTo(c.req.query("returnTo"))} />);
  });

  app.post("/login/webauthn/options", async (c) => {
    const { options, challengeId } = await startAuthentication(db, { rpId: c.var.rpId, origin: c.var.publicOrigin });
    return c.json({ options, challengeId });
  });

  app.post("/login/webauthn/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await finishAuthentication(db, { rpId: c.var.rpId, origin: c.var.publicOrigin }, body.response, body.challengeId);
    if ("error" in result) {
      recordAdmin(db, "login", { status: "error", detail: clientIp(c) });
      return c.json(result, 401);
    }
    recordAdmin(db, "login", { detail: clientIp(c) });
    const session = createSession(db, result.userId, c.req.header("user-agent"));
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.var.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
    const referer = c.req.header("referer");
    let returnTo = "/app";
    try {
      if (referer) returnTo = safeReturnTo(new URL(referer).searchParams.get("returnTo") ?? undefined);
    } catch {}
    return c.json({ ok: true, returnTo });
  });

  app.post("/logout", (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) deleteSession(db, cookie);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    recordAdmin(db, "logout");
    return c.redirect("/login");
  });

  return app;
}
