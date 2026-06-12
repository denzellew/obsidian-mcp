import type { Context } from "hono";
import type { Config } from "../config.ts";

export interface ResolvedOrigin {
  /** Public origin, e.g. https://notes.example.com */
  origin: string;
  /** WebAuthn relying-party ID (hostname of origin) */
  rpId: string;
  /** Whether cookies should carry the Secure flag (https). */
  secure: boolean;
}

function hostnameOf(host: string): string {
  // strip port; handle bracketed IPv6
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon > -1 ? host.slice(0, colon) : host;
}

export function isLocalHost(host: string): boolean {
  const h = hostnameOf(host).replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Resolve the public origin for a request.
 *
 * - Fixed mode (PUBLIC_URL set): always the configured origin/rpID.
 * - Derived mode: from the reverse proxy's X-Forwarded-Proto / X-Forwarded-Host
 *   (falling back to the Host header). This is safe because WebAuthn binds the
 *   credential to the browser-signed origin regardless; an injected host cannot
 *   forge that, and the rpID is additionally pinned at setup (see webauthn.ts).
 */
export function resolveOrigin(c: Context, config: Config): ResolvedOrigin {
  if (!config.derived && config.publicUrl) {
    return {
      origin: config.publicUrl.origin,
      rpId: config.publicUrl.hostname,
      secure: config.publicUrl.protocol === "https:",
    };
  }
  const fwdHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = fwdHost || c.req.header("host") || `localhost:${config.port}`;
  const fwdProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = fwdProto || (isLocalHost(host) ? "http" : "https");
  const origin = `${proto}://${host}`;
  let rpId: string;
  try {
    rpId = new URL(origin).hostname;
  } catch {
    rpId = hostnameOf(host);
  }
  return { origin, rpId, secure: proto === "https" };
}
