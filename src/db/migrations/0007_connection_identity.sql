-- Identify connections by more than the name a client gives itself at
-- registration (claude.ai, Desktop and Claude Code all register as "Claude").
ALTER TABLE oauth_clients ADD COLUMN software_id TEXT;
ALTER TABLE oauth_clients ADD COLUMN software_version TEXT;
ALTER TABLE oauth_clients ADD COLUMN client_uri TEXT;

-- The owner's name for this client on this vault (NULL = auto-derived).
ALTER TABLE oauth_consents ADD COLUMN label TEXT;

-- clientInfo from the MCP initialize request, the most specific thing a client reports.
ALTER TABLE oauth_grants ADD COLUMN mcp_client_name TEXT;
ALTER TABLE oauth_grants ADD COLUMN mcp_client_version TEXT;
ALTER TABLE api_tokens ADD COLUMN mcp_client_name TEXT;
ALTER TABLE api_tokens ADD COLUMN mcp_client_version TEXT;

-- Which grant / token acted, so entries trace to one credential.
ALTER TABLE audit_log ADD COLUMN actor_id TEXT;
