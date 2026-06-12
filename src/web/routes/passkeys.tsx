import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { deleteOtherSessions } from "../../auth/sessions.ts";
import { deletePasskey, finishRegistration, listPasskeys, startRegistration, type PasskeyRow } from "../../auth/webauthn.ts";
import { recordAdmin } from "../../audit.ts";

function ago(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function PasskeyList(props: { passkeys: PasskeyRow[] }) {
  return (
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-base-700 text-left text-text-muted">
          <th class="py-2 pr-4 font-medium">Name</th>
          <th class="py-2 pr-4 font-medium">Type</th>
          <th class="py-2 pr-4 font-medium">Created</th>
          <th class="py-2 pr-4 font-medium">Last used</th>
          <th class="py-2"></th>
        </tr>
      </thead>
      <tbody>
        {props.passkeys.map((p) => (
          <tr class="border-b border-base-800">
            <td class="py-2 pr-4">{p.name}</td>
            <td class="py-2 pr-4 text-text-muted">{p.device_type === "multiDevice" ? "synced" : "device-bound"}</td>
            <td class="py-2 pr-4 text-text-muted">{ago(p.created_at)}</td>
            <td class="py-2 pr-4 text-text-muted">{ago(p.last_used_at)}</td>
            <td class="py-2 text-right">
              {props.passkeys.length > 1 ? (
                <button
                  hx-delete={`/app/passkeys/${encodeURIComponent(p.id)}`}
                  hx-confirm={`Delete passkey '${p.name}'?`}
                  hx-target="#passkey-list"
                  class="text-sm text-danger hover:underline"
                >
                  Delete
                </button>
              ) : (
                <span class="text-xs text-text-muted">last one</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PasskeysPage(props: { passkeys: PasskeyRow[] }) {
  return (
    <Layout title="Passkeys" activeNav="/app/passkeys">
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">Passkeys</h1>
        <Card title="Registered passkeys">
          <div id="passkey-list">
            <PasskeyList passkeys={props.passkeys} />
          </div>
        </Card>
        <Card title="Add a passkey">
          <form id="add-passkey-form" class="flex gap-3">
            <input
              id="add-passkey-name"
              type="text"
              placeholder="e.g. iPhone"
              class="flex-1 rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
            <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
              Add passkey
            </button>
          </form>
          <p id="add-passkey-status" class="mt-3 hidden text-sm text-text-muted"></p>
        </Card>
        <Card title="Sessions">
          <form method="post" action="/app/passkeys/sessions/clear-others">
            <button type="submit" class="rounded-md border border-base-600 px-4 py-2 text-sm text-text-muted hover:text-text">
              Sign out all other sessions
            </button>
          </form>
        </Card>
      </div>
      <script src="/assets/vendor/simplewebauthn-browser.min.js"></script>
      <script src="/assets/auth-client.js"></script>
    </Layout>
  );
}

export function passkeysRouter(db: Database, config: Config): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => c.html(<PasskeysPage passkeys={listPasskeys(db)} />));

  let pendingUserHandle: Uint8Array | null = null;

  app.post("/options", async (c) => {
    const { options, challengeId, userHandle } = await startRegistration(db, { rpId: c.var.rpId, origin: c.var.publicOrigin });
    pendingUserHandle = userHandle;
    return c.json({ options, challengeId });
  });

  app.post("/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!pendingUserHandle) return c.json({ error: "No registration in progress." }, 400);
    const result = await finishRegistration(
      db,
      { rpId: c.var.rpId, origin: c.var.publicOrigin },
      body.response,
      body.challengeId,
      String(body.name ?? "").trim() || "Unnamed passkey",
      pendingUserHandle,
    );
    pendingUserHandle = null;
    if ("error" in result) return c.json(result, 400);
    recordAdmin(db, "passkey.add", { target: String(body.name ?? "").trim() || "Unnamed passkey" });
    return c.json({ ok: true });
  });

  app.delete("/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const name = listPasskeys(db).find((p) => p.id === id)?.name ?? id;
    const result = deletePasskey(db, id);
    if ("error" in result) {
      return c.html(
        <>
          <p class="mb-3 text-sm text-danger">{result.error}</p>
          <PasskeyList passkeys={listPasskeys(db)} />
        </>,
      );
    }
    recordAdmin(db, "passkey.delete", { target: name });
    return c.html(<PasskeyList passkeys={listPasskeys(db)} />);
  });

  app.post("/sessions/clear-others", (c) => {
    const cookie = c.var.sessionCookie;
    if (cookie) deleteOtherSessions(db, cookie);
    recordAdmin(db, "session.revoke_others");
    return c.redirect("/app/passkeys");
  });

  return app;
}
