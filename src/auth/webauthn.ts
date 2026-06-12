import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Config } from "../config.ts";

const CHALLENGE_TTL_S = 300;

export interface PasskeyRow {
  id: string;
  user_id: number;
  name: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

function storeChallenge(db: Database, type: "registration" | "authentication", challenge: string): string {
  const id = randomBytes(16).toString("base64url");
  db.query("INSERT INTO webauthn_challenges (id, type, challenge, expires_at) VALUES (?, ?, ?, ?)").run(
    id,
    type,
    challenge,
    Math.floor(Date.now() / 1000) + CHALLENGE_TTL_S,
  );
  return id;
}

/** Single-use challenge consumption. */
function consumeChallenge(db: Database, id: string | undefined, type: "registration" | "authentication"): string | null {
  if (!id) return null;
  const row = db
    .query<{ challenge: string; expires_at: number }, [string, string]>(
      "SELECT challenge, expires_at FROM webauthn_challenges WHERE id = ? AND type = ?",
    )
    .get(id, type);
  if (row) db.query("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.challenge;
}

function getOrCreateUserHandle(db: Database): Uint8Array<ArrayBuffer> {
  const user = db.query<{ user_handle: Uint8Array }, []>("SELECT user_handle FROM users WHERE id = 1").get();
  const src = user ? user.user_handle : randomBytes(16);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

export function listPasskeys(db: Database): PasskeyRow[] {
  return db.query<PasskeyRow, []>("SELECT * FROM passkey_credentials ORDER BY created_at").all();
}

export function passkeyCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM passkey_credentials").get()!.n;
}

/** Start a passkey registration ceremony (setup or add-passkey). */
export async function startRegistration(db: Database, config: Config) {
  const userHandle = getOrCreateUserHandle(db);
  const existing = listPasskeys(db);
  const options = await generateRegistrationOptions({
    rpName: "Obsidian MCP",
    rpID: config.rpId,
    userID: userHandle,
    userName: "owner",
    userDisplayName: "Owner",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = storeChallenge(db, "registration", options.challenge);
  return { options, challengeId, userHandle };
}

/** Verify registration; creates the user row on first passkey. Returns credential id. */
export async function finishRegistration(
  db: Database,
  config: Config,
  body: RegistrationResponseJSON,
  challengeId: string | undefined,
  name: string,
  userHandle: Uint8Array,
): Promise<{ credentialId: string } | { error: string }> {
  const challenge = consumeChallenge(db, challengeId, "registration");
  if (!challenge) return { error: "Challenge expired or missing — reload the page and try again." };
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    return { error: `Passkey verification failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!verification.verified || !verification.registrationInfo) return { error: "Passkey verification failed." };
  const info = verification.registrationInfo;

  const tx = db.transaction(() => {
    const user = db.query("SELECT id FROM users WHERE id = 1").get();
    if (!user) {
      db.query("INSERT INTO users (id, display_name, user_handle) VALUES (1, 'Owner', ?)").run(userHandle);
    }
    db.query(
      "INSERT INTO passkey_credentials (id, user_id, name, public_key, counter, transports, device_type, backed_up) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    ).run(
      info.credential.id,
      name,
      info.credential.publicKey,
      info.credential.counter,
      JSON.stringify(info.credential.transports ?? []),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
    );
  });
  tx();
  return { credentialId: info.credential.id };
}

/** Start an authentication ceremony (discoverable credentials → one-tap). */
export async function startAuthentication(db: Database, config: Config) {
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: "required",
    allowCredentials: [],
  });
  const challengeId = storeChallenge(db, "authentication", options.challenge);
  return { options, challengeId };
}

export async function finishAuthentication(
  db: Database,
  config: Config,
  body: AuthenticationResponseJSON,
  challengeId: string | undefined,
): Promise<{ userId: number } | { error: string }> {
  const challenge = consumeChallenge(db, challengeId, "authentication");
  if (!challenge) return { error: "Challenge expired or missing — reload the page and try again." };
  const cred = db.query<PasskeyRow, [string]>("SELECT * FROM passkey_credentials WHERE id = ?").get(body.id);
  if (!cred) return { error: "Unknown passkey. If you reset the server, register a new one via AUTH_RESET." };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
  } catch (err) {
    return { error: `Passkey verification failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!verification.verified) return { error: "Passkey verification failed." };
  db.query("UPDATE passkey_credentials SET counter = ?, last_used_at = unixepoch() WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    cred.id,
  );
  return { userId: cred.user_id };
}

export function deletePasskey(db: Database, id: string): { ok: true } | { error: string } {
  if (passkeyCount(db) <= 1) {
    return { error: "Cannot delete the last passkey — you would be locked out. Add another passkey first." };
  }
  db.query("DELETE FROM passkey_credentials WHERE id = ?").run(id);
  return { ok: true };
}

export function renamePasskey(db: Database, id: string, name: string) {
  db.query("UPDATE passkey_credentials SET name = ? WHERE id = ?").run(name, id);
}
