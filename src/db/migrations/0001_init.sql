-- exactly one row, id forced to 1
CREATE TABLE users (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  display_name  TEXT NOT NULL DEFAULT 'Owner',
  user_handle   BLOB NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE passkey_credentials (
  id              TEXT PRIMARY KEY,            -- base64url credential ID
  user_id         INTEGER NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  public_key      BLOB NOT NULL,               -- COSE key
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                        -- JSON array
  device_type     TEXT,
  backed_up       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at    INTEGER
);

-- short-lived, single-use; bound to browser via random id cookie
CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('registration','authentication')),
  challenge   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE ui_sessions (
  id           TEXT PRIMARY KEY,               -- SHA-256 of cookie value
  user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent   TEXT
);

-- RFC 7591 dynamic clients; public clients only (PKCE), no secrets
CREATE TABLE oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL DEFAULT 'Unnamed client',
  redirect_uris  TEXT NOT NULL,                -- JSON array
  logo_uri       TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  consented_at   INTEGER
);

CREATE TABLE oauth_authorization_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,               -- S256 only
  resource        TEXT,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- one row per grant; access+refresh rotate in place
CREATE TABLE oauth_grants (
  id                  TEXT PRIMARY KEY,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  access_token_hash   TEXT NOT NULL UNIQUE,
  access_expires_at   INTEGER NOT NULL,
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  refresh_expires_at  INTEGER NOT NULL,
  prev_refresh_hash   TEXT,
  prev_rotated_at     INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at        INTEGER,
  revoked_at          INTEGER
);

-- static bearer tokens (Claude Code etc.)
CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_prefix  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_grants_access  ON oauth_grants(access_token_hash);
CREATE INDEX idx_grants_refresh ON oauth_grants(refresh_token_hash);
CREATE INDEX idx_sessions_expiry ON ui_sessions(expires_at);
