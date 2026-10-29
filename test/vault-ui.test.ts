import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { createApiToken, listApiTokens } from "../src/auth/tokens.ts";
import { createSession } from "../src/auth/sessions.ts";
import { resetRateLimits, SESSION_COOKIE } from "../src/auth/middleware.ts";
import { recordAdmin } from "../src/audit.ts";
import { VaultRegistry, type VaultInstance } from "../src/vaults/registry.ts";
import { VAULT_COOKIE } from "../src/web/vault-context.tsx";

let dir: string;
let db: Database;
let vaults: VaultRegistry;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let def: VaultInstance;
let personal: VaultInstance;
let session: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "obmcp-vault-ui-"));
  const config = { ...loadConfig({ DATA_DIR: dir } as unknown as NodeJS.ProcessEnv), syncAutostart: false, obBin: "/nonexistent/ob" };
  db = openDatabase(":memory:");
  db.query("INSERT INTO vaults (slug, name) VALUES ('personal', 'Personal')").run();
  vaults = await VaultRegistry.boot(config, db);
  def = vaults.default();
  personal = vaults.get("personal")!;
  const app = createApp({ config, db, vaults, setupState: { token: "setup_testtoken", pendingUserHandle: null } });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
  session = `${SESSION_COOKIE}=${createSession(db, 1, "test-agent")}`;
});

afterAll(async () => {
  server?.stop(true);
  await vaults?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

/** Cookie header for a browser whose switcher is on `slug` (none = never switched). */
function as(slug?: string): string {
  return slug ? `${session}; ${VAULT_COOKIE}=${slug}` : session;
}

function post(path: string, cookie: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
}

describe("vault switcher", () => {
  test("defaults to the default vault and lists every vault", async () => {
    const html = await (await fetch(`${base}/app`, { headers: { Cookie: as() } })).text();
    expect(html).toContain('<option value="default" selected="">Vault</option>');
    expect(html).toContain('<option value="personal">Personal</option>');
    expect(html).toContain(`hx-headers="{&quot;X-Vault&quot;:&quot;default&quot;}"`);
    expect(html).toContain(`${base}/mcp`);
  });

  test("switching sets the cookie and returns to the same section", async () => {
    const res = await post("/app/vault", as(), { vault: "personal" }, { "HX-Request": "true", "HX-Current-URL": `${base}/app/snapshots/abc1234` });
    expect(res.status).toBe(200);
    expect(res.headers.get("hx-redirect")).toBe("/app/snapshots");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${VAULT_COOKIE}=personal`);
    expect(cookie).toContain("Path=/app");
    expect(cookie).toContain("HttpOnly");
  });

  test("selected vault drives the page", async () => {
    const html = await (await fetch(`${base}/app`, { headers: { Cookie: as("personal") } })).text();
    expect(html).toContain('<option value="personal" selected="">Personal</option>');
    expect(html).toContain(`${base}/v/personal/mcp`);
  });

  test("unknown vault is refused; a stale cookie falls back to the default vault", async () => {
    expect((await post("/app/vault", as(), { vault: "nope" })).status).toBe(400);
    const html = await (await fetch(`${base}/app`, { headers: { Cookie: as("deleted-vault") } })).text();
    expect(html).toContain('<option value="default" selected="">Vault</option>');
  });
});

describe("csrf", () => {
  // PUBLIC_URL is unset here, so the origin is derived per request (localhost:<port>,
  // not the localhost:3000 fallback) the same way it is behind a proxy.
  test("management forms check the request's derived public origin", async () => {
    expect((await post("/app/vault", as(), { vault: "default" })).status).toBe(302);
    expect((await post("/app/vault", as(), { vault: "default" }, { Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("stale-tab guard", () => {
  test("a mutation is applied to the vault its page was rendered for", async () => {
    const res = await post("/app/guidance", as("personal"), { guidance: "Personal rules" }, { "HX-Request": "true", "X-Vault": "personal" });
    expect(res.status).toBe(200);
    expect(personal.settings.get("vault_instructions")).toBe("Personal rules");
    expect(def.settings.get("vault_instructions")).toBeNull();
  });

  test("a tab rendered for another vault is refused and nothing changes", async () => {
    const res = await post("/app/guidance", as("personal"), { guidance: "Wrong vault" }, { "HX-Request": "true", "X-Vault": "default" });
    expect(res.status).toBe(409);
    expect(res.headers.get("hx-refresh")).toBe("true");
    expect(personal.settings.get("vault_instructions")).toBe("Personal rules");
    expect(def.settings.get("vault_instructions")).toBeNull();
  });

  test("a mutation that names no vault is refused", async () => {
    const res = await post("/app/guidance", as("personal"), { guidance: "Unscoped" }, { "HX-Request": "true" });
    expect(res.status).toBe(409);
    expect(personal.settings.get("vault_instructions")).toBe("Personal rules");
  });

  test("plain forms carry the vault as a hidden field", async () => {
    const page = await (await fetch(`${base}/app/sync`, { headers: { Cookie: as("personal") } })).text();
    expect(page).not.toContain('action="/app/sync/start"'); // sync not configured: no plain forms yet
    const stale = await post("/app/sync/start", as("personal"), { _vault: "default" });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("Nothing was changed");
    expect(personal.sync!.desiredRunning()).toBe(false);

    const ok = await post("/app/sync/start", as("personal"), { _vault: "personal" });
    expect(ok.status).toBe(302);
    expect(personal.sync!.desiredRunning()).toBe(true);
    expect(def.sync!.desiredRunning()).toBe(false);
    await personal.sync!.stop();
  });
});

describe("scoped pages", () => {
  test("tokens are created, listed, and revoked per vault", async () => {
    const res = await post("/app/tokens", as("personal"), { name: "personal-laptop" }, { "HX-Request": "true", "X-Vault": "personal" });
    expect(res.status).toBe(200);
    const created = listApiTokens(db, personal.id).find((t) => t.name === "personal-laptop")!;
    expect(created).toBeDefined();
    expect(listApiTokens(db, def.id).some((t) => t.name === "personal-laptop")).toBe(false);

    const defaultPage = await (await fetch(`${base}/app/tokens`, { headers: { Cookie: as("default") } })).text();
    expect(defaultPage).not.toContain("personal-laptop");

    // revoking from the default vault's page can't reach a personal token
    const del = await fetch(`${base}/app/tokens/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: as("default"), Origin: base, "HX-Request": "true", "X-Vault": "default" },
    });
    expect(del.status).toBe(200);
    expect(listApiTokens(db, personal.id).find((t) => t.id === created.id)!.revoked_at).toBeNull();
  });

  test("activity shows this vault's events plus server-wide ones", async () => {
    const token = createApiToken(db, "activity-check", personal.id);
    recordAdmin(db, "token.create", { target: "only-in-default", vaultId: def.id });
    recordAdmin(db, "passkey.add", { target: "server-wide-passkey" });
    const html = await (await fetch(`${base}/app/audit`, { headers: { Cookie: as("personal") } })).text();
    expect(html).toContain("server-wide-passkey");
    expect(html).not.toContain("only-in-default");
    expect(token.token).toStartWith("obmcp_");
  });

  test("connections list and revoke only the selected vault's consent", async () => {
    db.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, consented_at) VALUES ('obcl_both', 'Both Vaults', '[]', unixepoch())").run();
    db.query("INSERT INTO oauth_consents (client_id, vault_id) VALUES ('obcl_both', ?), ('obcl_both', ?)").run(def.id, personal.id);

    const del = await fetch(`${base}/app/connections/obcl_both`, {
      method: "DELETE",
      headers: { Cookie: as("personal"), Origin: base, "HX-Request": "true", "X-Vault": "personal" },
    });
    expect(del.status).toBe(200);
    const consents = db.query<{ vault_id: number }, []>("SELECT vault_id FROM oauth_consents WHERE client_id = 'obcl_both'").all();
    expect(consents.map((r) => r.vault_id)).toEqual([def.id]);
    const defaultPage = await (await fetch(`${base}/app/connections`, { headers: { Cookie: as("default") } })).text();
    expect(defaultPage).toContain("Both Vaults");

    await fetch(`${base}/app/connections/obcl_both`, {
      method: "DELETE",
      headers: { Cookie: as("default"), Origin: base, "HX-Request": "true", "X-Vault": "default" },
    });
    expect(db.query("SELECT 1 FROM oauth_clients WHERE client_id = 'obcl_both'").get()).toBeNull();
  });
});
