-- Generalize the MCP-only audit table into a unified event log covering both
-- agent (MCP tool) calls and the owner's security/config actions.
ALTER TABLE mcp_audit ADD COLUMN source TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE mcp_audit RENAME COLUMN tool TO event;
ALTER TABLE mcp_audit RENAME TO audit_log;
CREATE INDEX idx_audit_source ON audit_log(source, id DESC);
