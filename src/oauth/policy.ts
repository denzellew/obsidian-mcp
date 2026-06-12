/**
 * Redirect-URI policy. Registration is open (Claude requires DCR), so the
 * policy plus the passkey-gated consent screen is the security boundary:
 *  - any https:// URI is registrable (consent shows the host prominently)
 *  - http:// only on loopback (RFC 8252), any port
 */
export function isRegistrableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Match a presented redirect_uri against a registered one.
 * Exact match required, except loopback URIs compare ignoring the port
 * (RFC 8252 §7.3 — Claude Code uses arbitrary loopback ports).
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let r: URL, p: URL;
  try {
    r = new URL(registered);
    p = new URL(presented);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || p.protocol !== "http:") return false;
  if (!isLoopbackHost(r.hostname) || !isLoopbackHost(p.hostname)) return false;
  return r.pathname === p.pathname && r.search === p.search;
}

export function pkceChallengeFromVerifier(verifier: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return Buffer.from(hash).toString("base64url");
}
