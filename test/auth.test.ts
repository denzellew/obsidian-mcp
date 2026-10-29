import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { VaultStore } from "../src/vault/store.ts";
import { LinkIndex } from "../src/vault/links.ts";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { createVaultContext } from "../src/mcp/context.ts";
import { createApiToken, listApiTokens, revokeApiToken, verifyBearer, mintToken, hashToken } from "../src/auth/tokens.ts";
import { createSession, getSession, deleteSession, sweepExpired } from "../src/auth/sessions.ts";
import { resetRateLimits, SESSION_COOKIE } from "../src/auth/middleware.ts";
import { redirectUriMatches, isRegistrableRedirectUri } from "../src/oauth/policy.ts";
import { tmpVault, type TmpVault, singleVault } from "./helpers.ts";
import type { Database } from "bun:sqlite";

let vault: TmpVault;
let snapsDir: string;
let db: Database;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  vault = tmpVault({ "Note.md": "hello\n" });
  snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
  db = openDatabase(":memory:");
  const store = new VaultStore(vault.dir);
  const snapshotter = new Snapshotter(snapsDir, vault.dir, { debounceMs: 50, maxWaitMs: 500, intervalMs: 600_000 });
  await snapshotter.init();
  const vaultCtx = createVaultContext({ store, links: new LinkIndex(store), snapshotter });
  const config = loadConfig({ DATA_DIR: vault.dir, PUBLIC_URL: "http://localhost:3000" } as unknown as NodeJS.ProcessEnv);
  const app = createApp({ config, db, vaults: singleVault(config, db, vaultCtx), setupState: { token: "setup_testtoken", pendingUserHandle: null } });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  vault?.cleanup();
  rmSync(snapsDir, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

function sessionCookieHeader(): string {
  db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
  const value = createSession(db, 1, "test-agent");
  return `${SESSION_COOKIE}=${value}`;
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(redirectUris = ["http://localhost:33418/callback"]) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: redirectUris }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ client_id: string }>;
}

/** Full code flow with consent; returns the token response. */
async function fullOAuthFlow(opts: { resource?: string } = {}) {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkcePair();
  const cookie = sessionCookieHeader();
  const redirectUri = "http://localhost:33418/callback";
  const authorizeUrl =
    `${base}/oauth/authorize?response_type=code&client_id=${client_id}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=xyz` +
    (opts.resource ? `&resource=${encodeURIComponent(opts.resource)}` : "");

  let res = await fetch(authorizeUrl, { headers: { Cookie: cookie }, redirect: "manual" });
  expect(res.status).toBe(200); // consent page (first time for this client)
  expect(await res.text()).toContain("Test Client");

  const form = new URLSearchParams({
    decision: "approve",
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...(opts.resource ? { resource: opts.resource } : {}),
  });
  res = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost:3000" },
    body: form,
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code")!;
  expect(code).toStartWith("obac_");

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id,
      redirect_uri: redirectUri,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { tokens, client_id, code, verifier, redirectUri, cookie };
}

async function mcpPing(token: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await res.text();
  return res.status;
}

describe("static tokens", () => {
  test("mint, verify, last-used, revoke", () => {
    const { token, row } = createApiToken(db, "laptop");
    expect(token).toStartWith("obmcp_");
    expect(row.token_prefix).toBe(token.slice(0, 12));
    const principal = verifyBearer(db, token)!;
    expect(principal).toMatchObject({ kind: "static", name: "laptop" });
    expect(listApiTokens(db).find((t) => t.id === row.id)!.last_used_at).not.toBeNull();
    revokeApiToken(db, row.id);
    expect(verifyBearer(db, token)).toBeNull();
  });

  test("refresh/code prefixes never authenticate", () => {
    expect(verifyBearer(db, mintToken("refresh").token)).toBeNull();
    expect(verifyBearer(db, mintToken("code").token)).toBeNull();
  });
});

describe("sessions", () => {
  test("create/get/delete round-trip", () => {
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    const value = createSession(db, 1);
    expect(getSession(db, value)!.user_id).toBe(1);
    deleteSession(db, value);
    expect(getSession(db, value)).toBeNull();
  });

  test("expired sessions are rejected and swept", () => {
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    const value = createSession(db, 1);
    db.query("UPDATE ui_sessions SET expires_at = 1 WHERE id = ?").run(hashToken(value));
    expect(getSession(db, value)).toBeNull();
    sweepExpired(db);
  });
});

describe("/mcp auth", () => {
  test("401 without token, with WWW-Authenticate pointing at resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });

  test("401 with invalid token", async () => {
    expect(await mcpPing("obmcp_nonsense")).toBe(401);
  });

  test("200 with valid static token, 401 after revoke", async () => {
    const { token, row } = createApiToken(db, "mcp-test");
    expect(await mcpPing(token)).toBe(200);
    revokeApiToken(db, row.id);
    expect(await mcpPing(token)).toBe(401);
  });
});

describe("metadata endpoints", () => {
  test("protected resource metadata", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authorization_servers).toEqual(["http://localhost:3000"]);
    expect(String(body.resource)).toEndWith("/mcp");
  });

  test("authorization server metadata advertises S256 + DCR", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("redirect URI policy", () => {
  test("registrable URIs", () => {
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://evil.com/cb")).toBe(false);
    expect(isRegistrableRedirectUri("custom-scheme://cb")).toBe(false);
  });

  test("loopback matches ignore port only", () => {
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:54321/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:1/cb", "http://127.0.0.1:9/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:54321/other")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai:444/cb")).toBe(false);
  });

  test("DCR rejects bad redirect URIs and confidential clients", async () => {
    let res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }),
    });
    expect(res.status).toBe(400);
    res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_basic" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("OAuth flow", () => {
  test("authorize without session redirects to login with returnTo", async () => {
    const { client_id } = await registerClient();
    const res = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:33418/callback")}&code_challenge=x&code_challenge_method=S256`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?returnTo=");
  });

  test("authorize with unknown client renders error, never redirects", async () => {
    const res = await fetch(`${base}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent("http://localhost:1/cb")}`, {
      headers: { Cookie: sessionCookieHeader() },
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown client_id");
  });

  test("missing PKCE → error redirect to client", async () => {
    const { client_id } = await registerClient();
    const res = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:33418/callback")}`,
      { headers: { Cookie: sessionCookieHeader() }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_request");
  });

  test("wrong resource indicator → invalid_target", async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkcePair();
    const res = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:33418/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent("https://other.example/mcp")}`,
      { headers: { Cookie: sessionCookieHeader() }, redirect: "manual" },
    );
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  test("full flow: consent → code → tokens → /mcp access", async () => {
    const { tokens } = await fullOAuthFlow({ resource: "http://localhost:3000/mcp" });
    expect(tokens.access_token).toStartWith("obat_");
    expect(tokens.refresh_token).toStartWith("obrt_");
    expect(await mcpPing(tokens.access_token)).toBe(200);
  });

  test("second authorize for a consented client skips consent", async () => {
    const { client_id, cookie } = await fullOAuthFlow();
    const { challenge } = pkcePair();
    const res = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:33418/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=obac_");
  });

  test("PKCE mismatch rejected", async () => {
    const { client_id, cookie } = await fullOAuthFlow();
    const { challenge } = pkcePair(); // verifier discarded
    const res = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:33418/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaa",
        client_id,
        redirect_uri: "http://localhost:33418/callback",
      }),
    });
    expect(tokenRes.status).toBe(400);
    expect(((await tokenRes.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("code replay revokes the client's grants", async () => {
    const { tokens, client_id, code, verifier, redirectUri } = await fullOAuthFlow();
    const replay = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirectUri }),
    });
    expect(replay.status).toBe(400);
    // the original grant from the first exchange is now dead
    expect(await mcpPing(tokens.access_token)).toBe(401);
  });

  test("refresh rotation works; old access token dies; reuse outside grace is detected", async () => {
    const { tokens } = await fullOAuthFlow();
    const refreshRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    expect(refreshRes.status).toBe(200);
    const rotated = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(await mcpPing(rotated.access_token)).toBe(200);
    expect(await mcpPing(tokens.access_token)).toBe(401); // old access replaced

    // retry with the previous refresh token within grace → allowed (rotation retry)
    const retry = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    expect(retry.status).toBe(200);

    // push the rotation timestamp outside the grace window → reuse detection kills the grant
    db.query("UPDATE oauth_grants SET prev_rotated_at = prev_rotated_at - 700 WHERE prev_refresh_hash = ?").run(
      hashToken(tokens.refresh_token),
    );
    const reuse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    expect(reuse.status).toBe(400);
  });

  test("revocation endpoint kills the grant", async () => {
    const { tokens } = await fullOAuthFlow();
    const res = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token }),
    });
    expect(res.status).toBe(200);
    expect(await mcpPing(tokens.access_token)).toBe(401);
  });
});

describe("setup & login gating", () => {
  test("setup options requires the setup token", async () => {
    const res = await fetch(`${base}/setup/webauthn/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupToken: "wrong" }),
    });
    expect(res.status).toBe(403);
  });

  test("setup options with correct token returns WebAuthn options", async () => {
    const res = await fetch(`${base}/setup/webauthn/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupToken: "setup_testtoken" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: { challenge: string; rp: { id: string } } };
    expect(body.options.challenge).toBeTruthy();
    expect(body.options.rp.id).toBe("localhost");
  });

  test("setup 404s once a passkey exists; login serves options", async () => {
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    db.query(
      "INSERT OR IGNORE INTO passkey_credentials (id, user_id, name, public_key, counter) VALUES ('fake-cred', 1, 'Test', X'00', 0)",
    ).run();
    const setup = await fetch(`${base}/setup`);
    expect(setup.status).toBe(404);
    const login = await fetch(`${base}/login/webauthn/options`, { method: "POST" });
    expect(login.status).toBe(200);
  });

  test("/app redirects to login without a session", async () => {
    const res = await fetch(`${base}/app`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("/app works with a session", async () => {
    const res = await fetch(`${base}/app`, { headers: { Cookie: sessionCookieHeader() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Dashboard");
  });

  test("host guard rejects unexpected Host headers", async () => {
    const res = await fetch(`${base}/healthz`, { headers: { Host: "evil.example.com" } });
    expect(res.status).toBe(421);
  });
});
