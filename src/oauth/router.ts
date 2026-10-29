import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.ts";
import { abortRegistry, hashToken, mintToken } from "../auth/tokens.ts";
import { isRegistrableRedirectUri, pkceChallengeFromVerifier, redirectUriMatches } from "./policy.ts";
import { ConsentPage, OAuthErrorPage } from "../web/routes/consent.tsx";
import { recordAdmin } from "../audit.ts";
import { logger } from "../log.ts";
import type { VaultInstance, VaultRegistry } from "../vaults/registry.ts";

const log = logger("oauth");

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 60;
const REFRESH_REUSE_GRACE_S = 600;
const MAX_UNCONSENTED_CLIENTS = 100;

export interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  logo_uri: string | null;
  created_at: number;
  consented_at: number | null;
}

function getClient(db: Database, clientId: string): ClientRow | null {
  return db.query<ClientRow, [string]>("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
}

/**
 * Map an RFC 8707 resource indicator to the vault it names. It is required:
 * with no default vault, a grant must say which vault it opens.
 */
export function vaultForResource(vaults: VaultRegistry, origin: string, resource: string | undefined): VaultInstance | null {
  if (!resource) return null;
  const prefix = `${origin}/v/`;
  if (!resource.startsWith(prefix) || !resource.endsWith("/mcp")) return null;
  return vaults.get(resource.slice(prefix.length, -"/mcp".length)) ?? null;
}

function hasConsent(db: Database, clientId: string, vaultId: number): boolean {
  return !!db.query("SELECT 1 FROM oauth_consents WHERE client_id = ? AND vault_id = ?").get(clientId, vaultId);
}

// ---------------------------------------------------------------------------
// Metadata (mounted at /.well-known)

export function wellKnownRouter(vaults: VaultRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const prm = (origin: string, mcpPath: string, name: string) => ({
    resource: `${origin}${mcpPath}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: name,
  });
  const asMeta = (origin: string) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
  const cache = (c: { header: (k: string, v: string) => void }) => c.header("Cache-Control", "public, max-age=3600");
  app.get("/oauth-protected-resource/v/:slug/mcp", (c) => {
    const vault = vaults.get(c.req.param("slug"));
    if (!vault) return c.json({ error: "not_found", error_description: "No such vault" }, 404);
    cache(c);
    return c.json(prm(c.var.publicOrigin, `/v/${vault.slug}/mcp`, `Obsidian MCP · ${vault.name}`));
  });
  app.get("/oauth-authorization-server", (c) => (cache(c), c.json(asMeta(c.var.publicOrigin))));
  return app;
}

// ---------------------------------------------------------------------------
// Public endpoints: register / token / revoke

export function oauthPublicRouter(db: Database, vaults: VaultRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // RFC 8707: a resource sent to the token endpoint must name the vault the grant is bound to
  const resourceMismatch = (origin: string, resource: unknown, vaultId: number) =>
    typeof resource === "string" && resource !== "" && vaultForResource(vaults, origin, resource)?.id !== vaultId;

  // RFC 7591 Dynamic Client Registration
  app.post("/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of strings" }, 400);
    }
    for (const uri of redirectUris as string[]) {
      if (!isRegistrableRedirectUri(uri)) {
        return c.json(
          { error: "invalid_redirect_uri", error_description: `Redirect URI not allowed: ${uri}. Use https://, or http:// on loopback.` },
          400,
        );
      }
    }
    const authMethod = (body.token_endpoint_auth_method as string) ?? "none";
    if (authMethod !== "none") {
      return c.json(
        { error: "invalid_client_metadata", error_description: "Only public clients are supported (token_endpoint_auth_method: 'none')" },
        400,
      );
    }

    // cap junk registrations: evict oldest unconsented clients beyond the limit
    db.query(
      `DELETE FROM oauth_clients WHERE consented_at IS NULL AND client_id IN (
         SELECT client_id FROM oauth_clients WHERE consented_at IS NULL
         ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
    ).run(MAX_UNCONSENTED_CLIENTS - 1);

    const clientId = `obcl_${randomBytes(15).toString("base64url")}`;
    const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "Unnamed client";
    const logoUri = typeof body.logo_uri === "string" ? body.logo_uri.slice(0, 500) : null;
    db.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, logo_uri) VALUES (?, ?, ?, ?)").run(
      clientId,
      clientName,
      JSON.stringify(redirectUris),
      logoUri,
    );
    log.info(`registered OAuth client '${clientName}' (${clientId})`);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  // Token endpoint
  app.post("/token", async (c) => {
    const body = await c.req.parseBody();
    const grantType = String(body.grant_type ?? "");

    if (grantType === "authorization_code") {
      const code = String(body.code ?? "");
      const verifier = String(body.code_verifier ?? "");
      const clientId = String(body.client_id ?? "");
      const redirectUri = String(body.redirect_uri ?? "");
      if (!code || !verifier || !clientId) {
        return c.json({ error: "invalid_request", error_description: "code, code_verifier and client_id are required" }, 400);
      }
      const row = db
        .query<
          { code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string | null; vault_id: number; expires_at: number; used_at: number | null },
          [string]
        >("SELECT * FROM oauth_authorization_codes WHERE code_hash = ?")
        .get(hashToken(code));
      if (!row) return c.json({ error: "invalid_grant", error_description: "Unknown authorization code" }, 400);
      if (row.used_at) {
        // code replay: revoke everything this client holds (RFC 6749 §4.1.2)
        db.query("UPDATE oauth_grants SET revoked_at = unixepoch() WHERE client_id = ? AND revoked_at IS NULL").run(row.client_id);
        log.warn(`authorization code replay for client ${row.client_id} — revoked all grants`);
        return c.json({ error: "invalid_grant", error_description: "Authorization code already used" }, 400);
      }
      if (row.expires_at < Math.floor(Date.now() / 1000)) {
        return c.json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
      }
      if (row.client_id !== clientId) return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
      if (row.redirect_uri !== redirectUri) return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      if (pkceChallengeFromVerifier(verifier) !== row.code_challenge) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }
      if (resourceMismatch(c.var.publicOrigin, body.resource, row.vault_id)) {
        return c.json({ error: "invalid_target", error_description: "resource does not match the one this code was issued for" }, 400);
      }
      db.query("UPDATE oauth_authorization_codes SET used_at = unixepoch() WHERE code_hash = ?").run(row.code_hash);

      const access = mintToken("access");
      const refresh = mintToken("refresh");
      const now = Math.floor(Date.now() / 1000);
      db.query(
        "INSERT INTO oauth_grants (id, client_id, vault_id, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(randomBytes(12).toString("base64url"), clientId, row.vault_id, access.hash, now + ACCESS_TTL_S, refresh.hash, now + REFRESH_TTL_S);
      return c.json({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: refresh.token,
        scope: "mcp",
      });
    }

    if (grantType === "refresh_token") {
      const presented = String(body.refresh_token ?? "");
      if (!presented) return c.json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
      const h = hashToken(presented);
      const now = Math.floor(Date.now() / 1000);

      let grant = db
        .query<{ id: string; vault_id: number; refresh_expires_at: number; revoked_at: number | null }, [string]>(
          "SELECT id, vault_id, refresh_expires_at, revoked_at FROM oauth_grants WHERE refresh_token_hash = ?",
        )
        .get(h);

      if (!grant) {
        // previous-refresh-token window: a client retrying a rotation it never received
        const prev = db
          .query<{ id: string; vault_id: number; prev_rotated_at: number | null; revoked_at: number | null }, [string]>(
            "SELECT id, vault_id, prev_rotated_at, revoked_at FROM oauth_grants WHERE prev_refresh_hash = ?",
          )
          .get(h);
        if (prev && !prev.revoked_at && prev.prev_rotated_at && now - prev.prev_rotated_at <= REFRESH_REUSE_GRACE_S) {
          grant = { id: prev.id, vault_id: prev.vault_id, refresh_expires_at: now + 1, revoked_at: null };
        } else if (prev) {
          // reuse outside the grace window → token theft signal → kill the grant
          db.query("UPDATE oauth_grants SET revoked_at = unixepoch() WHERE id = ?").run(prev.id);
          log.warn(`refresh token reuse detected for grant ${prev.id} — revoked`);
          return c.json({ error: "invalid_grant", error_description: "Refresh token reuse detected; re-authorize" }, 400);
        } else {
          return c.json({ error: "invalid_grant", error_description: "Unknown refresh token" }, 400);
        }
      }
      if (grant.revoked_at) return c.json({ error: "invalid_grant", error_description: "Grant revoked" }, 400);
      if (grant.refresh_expires_at < now) return c.json({ error: "invalid_grant", error_description: "Refresh token expired; re-authorize" }, 400);
      if (resourceMismatch(c.var.publicOrigin, body.resource, grant.vault_id)) {
        return c.json({ error: "invalid_target", error_description: "resource does not match the vault this grant is for; authorize for it separately" }, 400);
      }

      const access = mintToken("access");
      const refresh = mintToken("refresh");
      db.query(
        `UPDATE oauth_grants SET
           access_token_hash = ?, access_expires_at = ?,
           prev_refresh_hash = refresh_token_hash, prev_rotated_at = ?,
           refresh_token_hash = ?, refresh_expires_at = ?
         WHERE id = ?`,
      ).run(access.hash, now + ACCESS_TTL_S, now, refresh.hash, now + REFRESH_TTL_S, grant.id);
      return c.json({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: refresh.token,
        scope: "mcp",
      });
    }

    return c.json({ error: "unsupported_grant_type", error_description: `Unsupported grant_type '${grantType}'` }, 400);
  });

  // RFC 7009 revocation — always 200
  app.post("/revoke", async (c) => {
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    if (token) {
      const h = hashToken(token);
      const grant = db
        .query<{ id: string; access_token_hash: string; refresh_token_hash: string }, [string, string]>(
          "SELECT id, access_token_hash, refresh_token_hash FROM oauth_grants WHERE access_token_hash = ? OR refresh_token_hash = ?",
        )
        .get(h, h);
      if (grant) {
        db.query("UPDATE oauth_grants SET revoked_at = unixepoch() WHERE id = ?").run(grant.id);
        abortRegistry.abort(grant.access_token_hash);
      }
    }
    return c.json({});
  });

  return app;
}

// ---------------------------------------------------------------------------
// Interactive endpoints: authorize + consent (session middleware applied by caller)

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  resource?: string;
  vault: VaultInstance;
}

function validateAuthorizeRequest(
  db: Database,
  vaults: VaultRegistry,
  origin: string,
  q: Record<string, string | undefined>,
): { ok: true; client: ClientRow; params: AuthorizeParams } | { ok: false; fatal: string } | { ok: false; redirect: string } {
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const client = clientId ? getClient(db, clientId) : null;
  if (!client) return { ok: false, fatal: "Unknown client_id. The client must register first (this server supports Dynamic Client Registration)." };

  const registered: string[] = JSON.parse(client.redirect_uris);
  if (!redirectUri || !registered.some((r) => redirectUriMatches(r, redirectUri))) {
    return { ok: false, fatal: `redirect_uri is not registered for this client: ${redirectUri || "(missing)"}` };
  }

  // from here on, errors can be returned to the redirect URI
  const err = (code: string, desc: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", code);
    u.searchParams.set("error_description", desc);
    if (q.state) u.searchParams.set("state", q.state);
    return { ok: false as const, redirect: u.toString() };
  };

  if (q.response_type !== "code") return err("unsupported_response_type", "Only response_type=code is supported");
  if (!q.code_challenge) return err("invalid_request", "PKCE code_challenge is required");
  if ((q.code_challenge_method ?? "") !== "S256") return err("invalid_request", "code_challenge_method must be S256");
  const vault = vaultForResource(vaults, origin, q.resource);
  if (!vault) return err("invalid_target", `resource must be ${origin}/v/<vault>/mcp for an existing vault`);
  return {
    ok: true,
    client,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      state: q.state,
      code_challenge: q.code_challenge,
      resource: q.resource,
      vault,
    },
  };
}

function issueCodeAndRedirect(db: Database, params: AuthorizeParams): string {
  const code = mintToken("code");
  db.query(
    "INSERT INTO oauth_authorization_codes (code_hash, client_id, vault_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    code.hash,
    params.client_id,
    params.vault.id,
    params.redirect_uri,
    params.code_challenge,
    params.resource ?? null,
    Math.floor(Date.now() / 1000) + CODE_TTL_S,
  );
  const u = new URL(params.redirect_uri);
  u.searchParams.set("code", code.token);
  if (params.state) u.searchParams.set("state", params.state);
  return u.toString();
}

export function oauthInteractiveRouter(db: Database, vaults: VaultRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/authorize", (c) => {
    const q = Object.fromEntries(new URL(c.req.url).searchParams) as Record<string, string>;
    const v = validateAuthorizeRequest(db, vaults, c.var.publicOrigin, q);
    if (!v.ok) {
      if ("redirect" in v) return c.redirect(v.redirect);
      return c.html(OAuthErrorPage({ message: v.fatal }), 400);
    }
    if (hasConsent(db, v.params.client_id, v.params.vault.id)) {
      return c.redirect(issueCodeAndRedirect(db, v.params));
    }
    return c.html(ConsentPage({ client: v.client, vaultName: v.params.vault.name, params: q }));
  });

  app.post("/consent", async (c) => {
    const body = await c.req.parseBody();
    const q: Record<string, string> = {};
    for (const k of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "resource", "scope"]) {
      if (typeof body[k] === "string" && body[k]) q[k] = body[k] as string;
    }
    const v = validateAuthorizeRequest(db, vaults, c.var.publicOrigin, q);
    if (!v.ok) {
      if ("redirect" in v) return c.redirect(v.redirect);
      return c.html(OAuthErrorPage({ message: v.fatal }), 400);
    }
    if (body.decision !== "approve") {
      const u = new URL(v.params.redirect_uri);
      u.searchParams.set("error", "access_denied");
      u.searchParams.set("error_description", "The user denied the request");
      if (v.params.state) u.searchParams.set("state", v.params.state);
      return c.redirect(u.toString());
    }
    db.query("UPDATE oauth_clients SET consented_at = unixepoch() WHERE client_id = ?").run(v.params.client_id);
    db.query("INSERT OR REPLACE INTO oauth_consents (client_id, vault_id) VALUES (?, ?)").run(v.params.client_id, v.params.vault.id);
    recordAdmin(db, "oauth.consent", { target: v.client.client_name, vaultId: v.params.vault.id });
    return c.redirect(issueCodeAndRedirect(db, v.params));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Management queries for the UI

export interface ConnectionRow extends ClientRow {
  grants: { id: string; created_at: number; last_used_at: number | null; access_expires_at: number }[];
}

/** Clients approved for one vault, with their live grants for it. */
export function listConnections(db: Database, vaultId: number): ConnectionRow[] {
  const clients = db
    .query<ClientRow, [number]>(
      `SELECT c.client_id, c.client_name, c.redirect_uris, c.logo_uri, c.created_at, k.consented_at
       FROM oauth_clients c JOIN oauth_consents k ON k.client_id = c.client_id
       WHERE k.vault_id = ? ORDER BY k.consented_at DESC`,
    )
    .all(vaultId);
  return clients.map((client) => ({
    ...client,
    grants: db
      .query<{ id: string; created_at: number; last_used_at: number | null; access_expires_at: number }, [string, number]>(
        "SELECT id, created_at, last_used_at, access_expires_at FROM oauth_grants WHERE client_id = ? AND vault_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(client.client_id, vaultId),
  }));
}

/** Revoke a client's access to one vault. The registration itself goes once no vault is left approved. */
export function revokeClient(db: Database, clientId: string, vaultId: number) {
  const grants = db
    .query<{ access_token_hash: string }, [string, number]>(
      "SELECT access_token_hash FROM oauth_grants WHERE client_id = ? AND vault_id = ? AND revoked_at IS NULL",
    )
    .all(clientId, vaultId);
  db.transaction(() => {
    db.query("DELETE FROM oauth_grants WHERE client_id = ? AND vault_id = ?").run(clientId, vaultId);
    db.query("DELETE FROM oauth_consents WHERE client_id = ? AND vault_id = ?").run(clientId, vaultId);
    db.query("DELETE FROM oauth_clients WHERE client_id = ? AND NOT EXISTS (SELECT 1 FROM oauth_consents WHERE client_id = ?)").run(
      clientId,
      clientId,
    );
  })();
  for (const g of grants) abortRegistry.abort(g.access_token_hash);
}
