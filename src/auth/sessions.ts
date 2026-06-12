import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hashToken } from "./tokens.ts";

const SESSION_TTL_S = 30 * 24 * 3600;
const SLIDE_INTERVAL_S = 3600;

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  user_agent: string | null;
}

/** Create a session; returns the cookie value (only the hash is stored). */
export function createSession(db: Database, userId: number, userAgent?: string): string {
  const value = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  db.query("INSERT INTO ui_sessions (id, user_id, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)").run(
    hashToken(value),
    userId,
    now + SESSION_TTL_S,
    now,
    userAgent ?? null,
  );
  return value;
}

/** Validate a cookie value; bumps the sliding expiry at most once an hour. */
export function getSession(db: Database, cookieValue: string | undefined): SessionRow | null {
  if (!cookieValue) return null;
  const id = hashToken(cookieValue);
  const row = db.query<SessionRow, [string]>("SELECT * FROM ui_sessions WHERE id = ?").get(id);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.query("DELETE FROM ui_sessions WHERE id = ?").run(id);
    return null;
  }
  if (!row.last_seen_at || now - row.last_seen_at >= SLIDE_INTERVAL_S) {
    db.query("UPDATE ui_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").run(now + SESSION_TTL_S, now, id);
  }
  return row;
}

export function deleteSession(db: Database, cookieValue: string) {
  db.query("DELETE FROM ui_sessions WHERE id = ?").run(hashToken(cookieValue));
}

/** "Sign out everywhere else": delete all sessions except the current one. */
export function deleteOtherSessions(db: Database, currentCookieValue: string) {
  db.query("DELETE FROM ui_sessions WHERE id != ?").run(hashToken(currentCookieValue));
}

export function countSessions(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ui_sessions").get()!.n;
}

/** Hourly cleanup of expired auth rows. */
export function sweepExpired(db: Database) {
  const now = Math.floor(Date.now() / 1000);
  db.query("DELETE FROM ui_sessions WHERE expires_at < ?").run(now);
  db.query("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(now);
  db.query("DELETE FROM oauth_authorization_codes WHERE expires_at < ?").run(now - 600);
  db.query("DELETE FROM oauth_grants WHERE refresh_expires_at < ? AND revoked_at IS NULL").run(now);
}
