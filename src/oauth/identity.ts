import { isLoopbackHost } from "./policy.ts";

export const UNNAMED_CLIENT = "Unnamed client";
export const MAX_LABEL_CHARS = 80;

export interface ClientIdentity {
  client_name: string;
  /** JSON array, as stored in oauth_clients. */
  redirect_uris: string;
  mcp_client_name?: string | null;
  mcp_client_version?: string | null;
}

/**
 * Where the client receives its tokens, as a short human hint: the web host
 * (claude.ai), "local app" for loopback redirects, or the custom scheme.
 */
export function redirectHint(redirectUris: string): string | null {
  let first: string | undefined;
  try {
    first = (JSON.parse(redirectUris) as string[])[0];
  } catch {
    return null;
  }
  if (!first) return null;
  try {
    const u = new URL(first);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return isLoopbackHost(u.hostname) ? "local app" : u.host;
    }
    return u.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

export function mcpClientLabel(name?: string | null, version?: string | null): string | null {
  if (!name) return null;
  return version ? `${name} ${version}` : name;
}

/** Auto-derived connection name, e.g. "Claude · local app (claude-code 2.1.3)". */
export function describeClient(c: ClientIdentity): string {
  const hint = redirectHint(c.redirect_uris);
  const mcp = mcpClientLabel(c.mcp_client_name, c.mcp_client_version);
  const named = c.client_name && c.client_name !== UNNAMED_CLIENT;
  const base = named ? c.client_name : (mcp ?? hint ?? UNNAMED_CLIENT);
  let out = base;
  if (hint && hint !== base) out += ` · ${hint}`;
  if (mcp && named) out += ` (${mcp})`;
  return out;
}

/** The owner's label when set, else the auto-derived name. */
export function connectionName(label: string | null | undefined, c: ClientIdentity): string {
  const l = label?.trim();
  return l ? l : describeClient(c);
}

/** Normalize a label from a form: trimmed, capped; empty → null (use auto name). */
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const l = raw.trim().slice(0, MAX_LABEL_CHARS);
  return l || null;
}
