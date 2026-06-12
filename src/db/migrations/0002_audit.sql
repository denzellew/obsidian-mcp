-- Audit trail of MCP tool calls (who did what to the vault, via which client).
CREATE TABLE mcp_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL DEFAULT (unixepoch()),
  actor_kind  TEXT NOT NULL,   -- 'static' | 'oauth'
  actor_name  TEXT NOT NULL,   -- token/client name
  tool        TEXT NOT NULL,   -- e.g. edit_note
  action      TEXT,            -- sub-action, e.g. manage_note:delete, edit:append+replace
  target      TEXT,            -- path / query / date the call concerned
  status      TEXT NOT NULL,   -- 'ok' | 'error'
  detail      TEXT             -- short error message or summary
);

CREATE INDEX idx_audit_ts ON mcp_audit(id DESC);
