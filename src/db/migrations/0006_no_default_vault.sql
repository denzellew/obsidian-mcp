-- There is no default vault: the owner adds each one, and every vault lives
-- under DATA_DIR/vaults/<slug>/. The vault 0004 created is dropped along with
-- its credentials; its files in VAULT_DIR are left on disk, unserved.
-- No FK on these vault_id columns (see 0005), so they are cleared by hand;
-- settings and consents cascade.
DELETE FROM api_tokens WHERE vault_id = 1;
DELETE FROM oauth_grants WHERE vault_id = 1;
DELETE FROM oauth_authorization_codes WHERE vault_id = 1;
DELETE FROM vaults WHERE id = 1;
