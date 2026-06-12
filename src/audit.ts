import type { Database } from "bun:sqlite";
import type { AuthPrincipal } from "./auth/tokens.ts";

/** Where an audited event originated. Drives the UI source toggle. */
export type AuditSource = "agent" | "security" | "config";

export interface AuditEntry {
  id: number;
  ts: number;
  source: AuditSource;
  actor_kind: string;
  actor_name: string;
  event: string;
  action: string | null;
  target: string | null;
  status: "ok" | "error";
  detail: string | null;
}

/** Visual category for a badge. */
export type AuditCategory =
  | "read"
  | "create"
  | "edit"
  | "move"
  | "delete"
  | "daily"
  | "auth"
  | "session"
  | "config"
  | "other";

const READ_TOOLS = new Set(["vault_info", "browse_vault", "search_vault", "read_note", "get_links", "list_tags"]);

/** Which source bucket an owner ("admin") event belongs to. */
function adminSourceFor(event: string): AuditSource {
  if (event.startsWith("sync.") || event === "guidance.update" || event === "snapshot.restore") return "config";
  return "security";
}

export function categorize(source: AuditSource, event: string, action: string | null): AuditCategory {
  if (source === "agent") {
    if (READ_TOOLS.has(event)) return "read";
    if (event === "create_note") return "create";
    if (event === "edit_note") return "edit";
    if (event === "daily_note") return "daily";
    if (event === "manage_note") {
      if (action?.endsWith("delete")) return "delete";
      if (action?.endsWith("move")) return "move";
      if (action?.endsWith("copy")) return "create";
    }
    return "other";
  }
  // owner actions
  switch (event) {
    case "login":
    case "logout":
      return "session";
    case "passkey.add":
    case "token.create":
      return "create";
    case "passkey.delete":
    case "token.revoke":
    case "oauth.revoke":
      return "delete";
    case "oauth.consent":
    case "setup.complete":
    case "session.revoke_others":
      return "auth";
    case "snapshot.restore":
      return "edit";
    default:
      return event.startsWith("sync.") || event.startsWith("guidance") ? "config" : "other";
  }
}

const MAX_ROWS = 10_000;

function insert(
  db: Database,
  e: {
    source: AuditSource;
    actorKind: string;
    actorName: string;
    event: string;
    action?: string | null;
    target?: string | null;
    status?: "ok" | "error";
    detail?: string | null;
  },
) {
  db.query(
    "INSERT INTO audit_log (source, actor_kind, actor_name, event, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    e.source,
    e.actorKind,
    e.actorName,
    e.event,
    e.action ?? null,
    e.target ?? null,
    e.status ?? "ok",
    e.detail ?? null,
  );
}

// --- Agent (MCP) calls -----------------------------------------------------

/** Derive a concise (action, target) pair from a tool call's arguments. */
export function summarize(tool: string, args: Record<string, unknown>): { action: string | null; target: string | null } {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (tool) {
    case "manage_note":
      return {
        action: `manage_note:${str(args.action) ?? "?"}`,
        target: str(args.destination) ? `${str(args.path)} → ${str(args.destination)}` : str(args.path),
      };
    case "edit_note": {
      const types = Array.isArray(args.edits)
        ? [...new Set((args.edits as { type?: string }[]).map((e) => e.type).filter(Boolean))].join("+")
        : null;
      return { action: types ? `edit:${types}` : "edit_note", target: str(args.path) };
    }
    case "daily_note":
      return { action: `daily_note:${str(args.action) ?? "read"}`, target: str(args.date) ?? "today" };
    case "create_note":
      return { action: "create_note", target: str(args.path) };
    case "search_vault":
      return { action: "search_vault", target: str(args.query) ?? (str(args.tag) ? `#${str(args.tag)}` : null) };
    case "read_note":
      return {
        action: "read_note",
        target: str(args.path) ?? (Array.isArray(args.paths) ? `${(args.paths as string[]).length} notes` : null),
      };
    case "browse_vault":
      return { action: "browse_vault", target: str(args.path) ?? "/" };
    case "get_links":
      return { action: "get_links", target: str(args.path) };
    case "list_tags":
      return { action: "list_tags", target: str(args.prefix) };
    default:
      return { action: tool, target: str(args.path) ?? null };
  }
}

export function recordMcpCall(
  db: Database,
  principal: AuthPrincipal,
  tool: string,
  args: Record<string, unknown>,
  status: "ok" | "error",
  detail?: string,
) {
  const { action, target } = summarize(tool, args);
  insert(db, { source: "agent", actorKind: principal.kind, actorName: principal.name, event: tool, action, target, status, detail });
}

// --- Owner (security/config) actions ---------------------------------------

/** Record an owner action from the management UI. Source is derived from the event. */
export function recordAdmin(
  db: Database,
  event: string,
  opts: { target?: string | null; status?: "ok" | "error"; detail?: string | null; actorName?: string } = {},
) {
  insert(db, {
    source: adminSourceFor(event),
    actorKind: "user",
    actorName: opts.actorName ?? "owner",
    event,
    action: null,
    target: opts.target ?? null,
    status: opts.status ?? "ok",
    detail: opts.detail ?? null,
  });
}

// --- Reading ---------------------------------------------------------------

export interface AuditQuery {
  limit?: number;
  beforeId?: number;
  source?: AuditSource;
}

export function listAudit(db: Database, q: AuditQuery = {}): AuditEntry[] {
  const limit = Math.min(q.limit ?? 100, 500);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.beforeId) {
    where.push("id < ?");
    params.push(q.beforeId);
  }
  if (q.source) {
    where.push("source = ?");
    params.push(q.source);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  return db.query<AuditEntry, (string | number)[]>(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`).all(...params);
}

export function pruneAudit(db: Database) {
  db.query("DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?)").run(MAX_ROWS);
}
