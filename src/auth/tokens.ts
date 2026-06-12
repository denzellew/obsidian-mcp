import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function randomBase32(bytes = 32): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (const b of buf) out += B32[b % 32];
  return out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type TokenKind = "static" | "access" | "refresh" | "code";

const PREFIX: Record<TokenKind, string> = {
  static: "obmcp_",
  access: "obat_",
  refresh: "obrt_",
  code: "obac_",
};

export function mintToken(kind: TokenKind): { token: string; hash: string; prefix: string } {
  const token = `${PREFIX[kind]}${randomBase32()}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

export function tokenKind(token: string): TokenKind | null {
  for (const [kind, prefix] of Object.entries(PREFIX) as [TokenKind, string][]) {
    if (token.startsWith(prefix)) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Static API tokens

export interface ApiTokenRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function createApiToken(db: Database, name: string): { token: string; row: ApiTokenRow } {
  const { token, hash, prefix } = mintToken("static");
  const id = randomBase32(8);
  db.query("INSERT INTO api_tokens (id, name, token_prefix, token_hash) VALUES (?, ?, ?, ?)").run(id, name, prefix, hash);
  const row = db.query<ApiTokenRow, [string]>("SELECT id, name, token_prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?").get(id)!;
  return { token, row };
}

export function listApiTokens(db: Database): ApiTokenRow[] {
  return db
    .query<ApiTokenRow, []>(
      "SELECT id, name, token_prefix, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC",
    )
    .all();
}

const LAST_USED_THROTTLE_S = 60;

export interface AuthPrincipal {
  kind: "static" | "oauth";
  id: string;
  name: string;
}

export function verifyApiToken(db: Database, token: string): AuthPrincipal | null {
  const row = db
    .query<{ id: string; name: string; last_used_at: number | null }, [string]>(
      "SELECT id, name, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .get(hashToken(token));
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!row.last_used_at || now - row.last_used_at >= LAST_USED_THROTTLE_S) {
    db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { kind: "static", id: row.id, name: row.name };
}

export function revokeApiToken(db: Database, id: string): boolean {
  const res = db.query("UPDATE api_tokens SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL").run(id);
  if (res.changes > 0) {
    const row = db.query<{ token_hash: string }, [string]>("SELECT token_hash FROM api_tokens WHERE id = ?").get(id);
    if (row) abortRegistry.abort(row.token_hash);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OAuth access tokens (grants live in oauth/, verification lives here so /mcp
// has a single dispatch point)

export function verifyOAuthAccessToken(db: Database, token: string): AuthPrincipal | null {
  const row = db
    .query<{ id: string; client_id: string; client_name: string; access_expires_at: number; last_used_at: number | null }, [string]>(
      `SELECT g.id, g.client_id, c.client_name, g.access_expires_at, g.last_used_at
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
       WHERE g.access_token_hash = ? AND g.revoked_at IS NULL`,
    )
    .get(hashToken(token));
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.access_expires_at < now) return null;
  if (!row.last_used_at || now - row.last_used_at >= LAST_USED_THROTTLE_S) {
    db.query("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { kind: "oauth", id: row.id, name: row.client_name };
}

/** Dispatch on token prefix; unknown prefixes are tried against both tables. */
export function verifyBearer(db: Database, token: string): AuthPrincipal | null {
  const kind = tokenKind(token);
  if (kind === "static") return verifyApiToken(db, token);
  if (kind === "access") return verifyOAuthAccessToken(db, token);
  if (kind === "refresh" || kind === "code") return null;
  return verifyApiToken(db, token) ?? verifyOAuthAccessToken(db, token);
}

// ---------------------------------------------------------------------------
// Live-stream abort registry: revocation kills open SSE streams immediately

class AbortRegistry {
  private streams = new Map<string, Set<() => void>>();

  register(tokenHash: string, abort: () => void): () => void {
    let set = this.streams.get(tokenHash);
    if (!set) {
      set = new Set();
      this.streams.set(tokenHash, set);
    }
    set.add(abort);
    return () => {
      set.delete(abort);
      if (set.size === 0) this.streams.delete(tokenHash);
    };
  }

  abort(tokenHash: string) {
    const set = this.streams.get(tokenHash);
    if (!set) return;
    for (const fn of set) {
      try {
        fn();
      } catch {}
    }
    this.streams.delete(tokenHash);
  }
}

export const abortRegistry = new AbortRegistry();
