-- Every MCP credential is bound to one vault. Everything issued before this
-- migration was for the only vault there was. No REFERENCES clause: SQLite
-- refuses ADD COLUMN with a foreign key unless the default is NULL.
ALTER TABLE api_tokens ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oauth_grants ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oauth_authorization_codes ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1;

-- NULL for owner events that aren't about one vault (login, passkeys).
ALTER TABLE audit_log ADD COLUMN vault_id INTEGER;
UPDATE audit_log SET vault_id = 1 WHERE source = 'agent';

-- Consent is per (client, vault): approving a client for one vault must not
-- silently hand it tokens for another.
CREATE TABLE oauth_consents (
  client_id     TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  vault_id      INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  consented_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, vault_id)
);
INSERT INTO oauth_consents (client_id, vault_id, consented_at)
  SELECT client_id, 1, consented_at FROM oauth_clients WHERE consented_at IS NOT NULL;
