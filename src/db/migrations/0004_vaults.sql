-- Multiple vaults per server. The slug becomes a path segment on disk and in
-- URLs, so it is restricted to lowercase letters, digits, and inner hyphens.
CREATE TABLE vaults (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE CHECK (
                length(slug) BETWEEN 1 AND 40
                AND slug NOT GLOB '*[^a-z0-9-]*'
                AND slug NOT GLOB '-*'
                AND slug NOT GLOB '*-'
              ),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE vault_settings (
  vault_id  INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (vault_id, key)
);

-- The single pre-existing vault becomes vault 1 and takes its per-vault
-- settings with it. Login and hostname settings stay global.
INSERT INTO vaults (id, slug, name) VALUES (1, 'default', 'Vault');
INSERT INTO vault_settings (vault_id, key, value)
  SELECT 1, key, value FROM settings WHERE key IN ('vault_instructions', 'sync_configured', 'sync_desired');
DELETE FROM settings WHERE key IN ('vault_instructions', 'sync_configured', 'sync_desired');
