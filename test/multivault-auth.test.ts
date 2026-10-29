import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { createApiToken } from "../src/auth/tokens.ts";
import { createSession } from "../src/auth/sessions.ts";
import { resetRateLimits, SESSION_COOKIE } from "../src/auth/middleware.ts";
import { VaultRegistry } from "../src/vaults/registry.ts";

let dir: string;
let db: Database;
let vaults: VaultRegistry;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let personalId: number;

const REDIRECT = "http://localhost:33418/callback";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "obmcp-multivault-"));
  const config = { ...loadConfig({ DATA_DIR: dir } as unknown as NodeJS.ProcessEnv), syncAutostart: false, obBin: "/nonexistent/ob" };
  db = openDatabase(":memory:");
  personalId = Number(db.query("INSERT INTO vaults (slug, name) VALUES ('personal', 'Personal')").run().lastInsertRowid);
  vaults = await VaultRegistry.boot(config, db);
  const app = createApp({ config, db, vaults, setupState: { token: "setup_testtoken", pendingUserHandle: null } });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await vaults?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

async function ping(path: string, token?: string): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await res.clone().text();
  return res;
}

function sessionCookie(): string {
  db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
  return `${SESSION_COOKIE}=${createSession(db, 1, "test-agent")}`;
}

async function registerClient(): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT] }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, resource: string): string {
  return (
    `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`
  );
}

/** Authorize (approving consent if shown) and exchange the code; returns the token response. */
async function oauthFor(clientId: string, resource: string, tokenResource?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookie = sessionCookie();
  let res = await fetch(authorizeUrl(clientId, challenge, resource), { headers: { Cookie: cookie }, redirect: "manual" });
  const consentShown = res.status === 200;
  const consentHtml = consentShown ? await res.text() : "";
  if (consentShown) {
    res = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: base },
      body: new URLSearchParams({
        decision: "approve",
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
      }),
      redirect: "manual",
    });
  }
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      ...(tokenResource ? { resource: tokenResource } : {}),
    }),
  });
  return { consentShown, consentHtml, tokenRes };
}

describe("per-vault MCP endpoints", () => {
  test("static tokens only open the vault they were issued for", async () => {
    const def = createApiToken(db, "default-token").token;
    const personal = createApiToken(db, "personal-token", personalId).token;

    expect((await ping("/mcp", def)).status).toBe(200);
    expect((await ping("/v/default/mcp", def)).status).toBe(200);
    expect((await ping("/v/personal/mcp", def)).status).toBe(401);

    expect((await ping("/v/personal/mcp", personal)).status).toBe(200);
    expect((await ping("/mcp", personal)).status).toBe(401);
    expect((await ping("/v/default/mcp", personal)).status).toBe(401);
  });

  test("cross-vault 401 points the client at the right vault's metadata", async () => {
    const def = createApiToken(db, "default-token").token;
    const res = await ping("/v/personal/mcp", def);
    expect(res.headers.get("www-authenticate")).toContain(`${base}/.well-known/oauth-protected-resource/v/personal/mcp`);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(((await res.json()) as { error_description: string }).error_description).toContain("'personal'");
  });

  test("unknown vault slug is a 404, not an auth challenge", async () => {
    const res = await ping("/v/nope/mcp", createApiToken(db, "t").token);
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  test("tool calls are audited against the vault they ran on", async () => {
    const token = createApiToken(db, "audited", personalId).token;
    const res = await fetch(`${base}/v/personal/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_info", arguments: {} } }),
    });
    await res.text();
    const row = db
      .query<{ vault_id: number }, []>("SELECT vault_id FROM audit_log WHERE actor_name = 'audited' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row?.vault_id).toBe(personalId);
  });
});

describe("per-vault OAuth", () => {
  test("protected resource metadata is published per vault", async () => {
    const personal = (await (await fetch(`${base}/.well-known/oauth-protected-resource/v/personal/mcp`)).json()) as Record<string, unknown>;
    expect(personal.resource).toBe(`${base}/v/personal/mcp`);
    expect(personal.authorization_servers).toEqual([base]);
    const legacy = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(legacy.resource).toBe(`${base}/mcp`);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/v/nope/mcp`)).status).toBe(404);
  });

  test("the resource indicator decides which vault the grant opens", async () => {
    const clientId = await registerClient();
    const { consentHtml, tokenRes } = await oauthFor(clientId, `${base}/v/personal/mcp`);
    expect(consentHtml).toContain("Personal");
    const { access_token, refresh_token } = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    expect((await ping("/v/personal/mcp", access_token)).status).toBe(200);
    expect((await ping("/mcp", access_token)).status).toBe(401);

    // refreshing keeps the binding
    const refreshed = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
    });
    const next = (await refreshed.json()) as { access_token: string };
    expect((await ping("/v/personal/mcp", next.access_token)).status).toBe(200);
    expect((await ping("/v/default/mcp", next.access_token)).status).toBe(401);
  });

  test("consent for one vault does not carry over to another", async () => {
    const clientId = await registerClient();
    expect((await oauthFor(clientId, `${base}/mcp`)).consentShown).toBe(true);
    expect((await oauthFor(clientId, `${base}/v/default/mcp`)).consentShown).toBe(false);
    expect((await oauthFor(clientId, `${base}/v/personal/mcp`)).consentShown).toBe(true);
    expect((await oauthFor(clientId, `${base}/v/personal/mcp`)).consentShown).toBe(false);
  });

  test("unknown vault resource → invalid_target", async () => {
    const clientId = await registerClient();
    const res = await fetch(authorizeUrl(clientId, "x", `${base}/v/nope/mcp`), { headers: { Cookie: sessionCookie() }, redirect: "manual" });
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  test("token request naming a different vault than the code → invalid_target", async () => {
    const clientId = await registerClient();
    const { tokenRes } = await oauthFor(clientId, `${base}/v/personal/mcp`, `${base}/mcp`);
    expect(tokenRes.status).toBe(400);
    expect(((await tokenRes.json()) as { error: string }).error).toBe("invalid_target");
  });
});
