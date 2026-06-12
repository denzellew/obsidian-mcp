import type { Database } from "bun:sqlite";
import type { AuthPrincipal } from "../auth/tokens.ts";

export interface AuditEntry {
  id: number;
  ts: number;
  actor_kind: string;
  actor_name: string;
  tool: string;
  action: string | null;
  target: string | null;
  status: "ok" | "error";
  detail: string | null;
}

/** Visual category for a tool call, used to colour the UI badge. */
export type AuditCategory = "read" | "create" | "edit" | "move" | "delete" | "daily" | "other";

const READ_TOOLS = new Set(["vault_info", "browse_vault", "search_vault", "read_note", "get_links", "list_tags"]);

export function categorize(tool: string, action: string | null): AuditCategory {
  if (READ_TOOLS.has(tool)) return "read";
  if (tool === "create_note") return "create";
  if (tool === "edit_note") return "edit";
  if (tool === "daily_note") return "daily";
  if (tool === "manage_note") {
    if (action?.endsWith("delete")) return "delete";
    if (action?.endsWith("move")) return "move";
    if (action?.endsWith("copy")) return "create";
  }
  return "other";
}

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
      return { action: "read_note", target: str(args.path) ?? (Array.isArray(args.paths) ? `${(args.paths as string[]).length} notes` : null) };
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

const MAX_ROWS = 10_000;

export function recordAudit(
  db: Database,
  principal: AuthPrincipal,
  tool: string,
  args: Record<string, unknown>,
  status: "ok" | "error",
  detail?: string,
) {
  const { action, target } = summarize(tool, args);
  db.query(
    "INSERT INTO mcp_audit (actor_kind, actor_name, tool, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(principal.kind, principal.name, tool, action, target, status, detail ?? null);
}

export interface AuditQuery {
  limit?: number;
  beforeId?: number;
  tool?: string;
  writesOnly?: boolean;
}

export function listAudit(db: Database, q: AuditQuery = {}): AuditEntry[] {
  const limit = Math.min(q.limit ?? 100, 500);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.beforeId) {
    where.push("id < ?");
    params.push(q.beforeId);
  }
  if (q.tool) {
    where.push("tool = ?");
    params.push(q.tool);
  }
  if (q.writesOnly) {
    where.push("tool NOT IN ('vault_info','browse_vault','search_vault','read_note','get_links','list_tags')");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  return db.query<AuditEntry, (string | number)[]>(`SELECT * FROM mcp_audit ${clause} ORDER BY id DESC LIMIT ?`).all(...params);
}

/** Trim the audit log to the most recent MAX_ROWS entries. */
export function pruneAudit(db: Database) {
  db.query(
    "DELETE FROM mcp_audit WHERE id <= (SELECT id FROM mcp_audit ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(MAX_ROWS);
}
