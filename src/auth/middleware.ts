import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { getSession, type SessionRow } from "./sessions.ts";
import { verifyBearer, type AuthPrincipal } from "./tokens.ts";
import { resolveOrigin, isLocalHost } from "../web/origin.ts";
import { getSetting } from "../db/index.ts";

export const SESSION_COOKIE = "obmcp_sid";

export type AuthEnv = {
  Variables: {
    session?: SessionRow;
    sessionCookie?: string;
    principal?: AuthPrincipal;
    bearerToken?: string;
    /** Public origin for this request (configured or proxy-derived). */
    publicOrigin: string;
    /** WebAuthn rpID for this request. */
    rpId: string;
    /** Whether cookies should be Secure (https). */
    secureCookies: boolean;
  };
};

/** Resolve the public origin once per request and stash it in context. */
export function resolveOriginMiddleware(config: Config): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const r = resolveOrigin(c, config);
    c.set("publicOrigin", r.origin);
    c.set("rpId", r.rpId);
    c.set("secureCookies", r.secure);
    await next();
  };
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.path.startsWith("/app") || c.req.path === "/login" || c.req.path.startsWith("/setup") || c.req.path.startsWith("/oauth/authorize")) {
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
    }
  };
}

/**
 * DNS-rebinding defense. In fixed mode the Host must match PUBLIC_URL's host.
 * In derived mode the host is trusted from the proxy, but once a passkey is
 * registered the rpID is pinned, so we require the request host to match the
 * pinned rpID (localhost always allowed for internal health checks).
 */
export function hostGuard(db: Database, config: Config): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!config.derived && config.publicUrl) {
      // fixed mode: compare the raw Host (proxy preserves it, or localhost dev)
      const host = c.req.header("host");
      if (!host || isLocalHost(host) || host === config.publicUrl.host) return next();
      return c.text(`Misdirected request: expected host ${config.publicUrl.host}`, 421);
    }

    // derived mode: judge by the resolved (proxy-forwarded) host. The raw Host
    // is the proxy→app hop (often localhost) and isn't meaningful here.
    if (isLocalHost(c.var.rpId)) return next(); // local dev / internal health checks
    const pinned = getSetting(db, "rp_id_at_setup");
    if (!pinned || c.var.rpId === pinned) return next();
    return c.text(`Misdirected request: this server is bound to host ${pinned}`, 421);
  };
}

/** Origin allowlist for /mcp per MCP spec (when an Origin header is present). */
export function mcpOriginGuard(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (
      origin &&
      origin !== c.var.publicOrigin &&
      origin !== "https://claude.ai" &&
      origin !== "https://claude.com" &&
      !origin.startsWith("http://localhost:") &&
      !origin.startsWith("http://127.0.0.1:")
    ) {
      return c.text("Forbidden origin", 403);
    }
    return next();
  };
}

export function wwwAuthenticate(origin: string, error?: string): string {
  const meta = `${origin}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${meta}"${error ? `, error="${error}"` : ""}`;
}

/** Bearer auth for /mcp: static obmcp_ tokens and OAuth obat_ tokens. */
export function requireBearer(db: Database): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      c.header("WWW-Authenticate", wwwAuthenticate(c.var.publicOrigin));
      return c.json({ error: "unauthorized", error_description: "Missing bearer token" }, 401);
    }
    const principal = verifyBearer(db, token);
    if (!principal) {
      c.header("WWW-Authenticate", wwwAuthenticate(c.var.publicOrigin, "invalid_token"));
      return c.json({ error: "invalid_token", error_description: "Token is invalid, expired, or revoked" }, 401);
    }
    c.set("principal", principal);
    c.set("bearerToken", token);
    return next();
  };
}

/** Session auth for the management UI; redirects browsers to /login. */
export function requireSession(db: Database, opts: { redirect: boolean }): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = cookie ? getSession(db, cookie) : null;
    if (!session) {
      if (opts.redirect) {
        const returnTo = encodeURIComponent(c.req.path + (c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""));
        return c.redirect(`/login?returnTo=${returnTo}`);
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("session", session);
    c.set("sessionCookie", cookie);
    return next();
  };
}

/** Validate returnTo to prevent open redirects. */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw) return "/app";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/app";
  }
  if (decoded.startsWith("/app") || decoded.startsWith("/oauth/authorize")) return decoded;
  return "/app";
}

// ---------------------------------------------------------------------------
// In-memory token-bucket rate limiting (single user; false positives unlikely)

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(name: string, perMinute: number): MiddlewareHandler {
  return async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "local";
    const key = `${name}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: perMinute, last: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.last) / 60_000) * perMinute);
    b.last = now;
    if (b.tokens < 1) {
      return c.text("Too many requests — try again shortly.", 429);
    }
    b.tokens -= 1;
    return next();
  };
}

/** Test hook. */
export function resetRateLimits() {
  buckets.clear();
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
