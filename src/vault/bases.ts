import { z } from "zod";
import { Document, isMap, isSeq, parseDocument, YAMLSeq } from "yaml";

/**
 * Obsidian Bases (.base files): YAML describing database-like views over notes.
 * Edits go through the yaml Document API so the owner's comments and key
 * order survive round-trips.
 */

export const VIEW_TYPES = ["table", "cards", "list", "map"] as const;

export class BaseEditError extends Error {
  constructor(
    public code: "INVALID_BASE" | "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID_ARGS",
    message: string,
  ) {
    super(message);
  }
}

export type Filter = string | { and: Filter[] } | { or: Filter[] } | { not: Filter[] };

export const FilterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.object({ and: z.array(FilterSchema) }).strict(),
    z.object({ or: z.array(FilterSchema) }).strict(),
    z.object({ not: z.array(FilterSchema) }).strict(),
  ]),
);

export const ViewSchema = z
  .object({
    type: z.enum(VIEW_TYPES),
    name: z.string().min(1),
    filters: FilterSchema.optional(),
    order: z.array(z.string()).optional(),
    sort: z.array(z.object({ property: z.string(), direction: z.enum(["ASC", "DESC"]) }).passthrough()).optional(),
    limit: z.number().int().positive().optional(),
  })
  .passthrough();

const BaseSchema = z
  .object({
    filters: FilterSchema.optional(),
    formulas: z.record(z.string()).optional(),
    properties: z.record(z.object({ displayName: z.string().optional() }).passthrough()).optional(),
    views: z.array(ViewSchema).optional(),
  })
  .passthrough();

export type BaseView = z.infer<typeof ViewSchema>;

/** Problems with a parsed base, as human/model-readable strings. Empty = valid. */
export function validateBase(obj: unknown): string[] {
  if (obj === null || obj === undefined) return [];
  const r = BaseSchema.safeParse(obj);
  const problems = r.success
    ? []
    : r.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (r.success && r.data.views) {
    const seen = new Set<string>();
    for (const v of r.data.views) {
      if (seen.has(v.name)) problems.push(`views: duplicate view name '${v.name}' (names must be unique)`);
      seen.add(v.name);
    }
  }
  return problems;
}

/** Parse a .base file. Throws INVALID_BASE on YAML syntax errors. */
export function parseBaseDoc(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length) {
    throw new BaseEditError("INVALID_BASE", `Invalid YAML: ${doc.errors.map((e) => e.message).join("; ")}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new BaseEditError("INVALID_BASE", "A base must be a YAML mapping at the top level (filters, formulas, properties, views).");
  }
  return doc;
}

export function summarizeBase(obj: unknown): { views: { name: string; type: string }[]; formulas: string[]; has_filters: boolean } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const views = Array.isArray(o.views)
    ? o.views.map((v) => ({ name: String((v as BaseView)?.name ?? ""), type: String((v as BaseView)?.type ?? "") }))
    : [];
  const formulas = o.formulas && typeof o.formulas === "object" ? Object.keys(o.formulas) : [];
  return { views, formulas, has_filters: o.filters !== undefined };
}

/** Serialize a new base from structured parts; omits empty sections. */
export function buildBase(parts: {
  filters?: Filter;
  formulas?: Record<string, string>;
  properties?: Record<string, Record<string, unknown>>;
  views?: Record<string, unknown>[];
}): string {
  const obj: Record<string, unknown> = {};
  if (parts.filters !== undefined) obj.filters = parts.filters;
  if (parts.formulas && Object.keys(parts.formulas).length) obj.formulas = parts.formulas;
  if (parts.properties && Object.keys(parts.properties).length) obj.properties = parts.properties;
  obj.views = parts.views?.length ? parts.views : [{ type: "table", name: "Table" }];
  return new Document(obj).toString();
}

export type BaseEdit =
  | { type: "set_filters"; filters: Filter | null; view?: string }
  | { type: "set_formula"; name: string; expression: string }
  | { type: "remove_formula"; name: string }
  | { type: "set_property"; property: string; display_name: string }
  | { type: "remove_property"; property: string }
  | { type: "add_view"; view: Record<string, unknown> }
  | { type: "update_view"; name: string; set?: Record<string, unknown>; remove?: string[] }
  | { type: "remove_view"; name: string }
  | { type: "replace_yaml"; yaml: string };

function viewNames(doc: Document): string[] {
  const views = doc.get("views");
  if (!isSeq(views)) return [];
  return views.items.map((v) => (isMap(v) ? String(v.get("name") ?? "") : ""));
}

function viewIndex(doc: Document, name: string, where: string): number {
  const names = viewNames(doc);
  const i = names.indexOf(name);
  if (i < 0) {
    throw new BaseEditError("NOT_FOUND", `${where}: no view named '${name}'. Views: ${names.join(" | ") || "(none)"}.`);
  }
  return i;
}

/** Remove a map key and drop the map itself when it becomes empty. */
function deleteAndPrune(doc: Document, section: string, key: string, where: string, label: string): void {
  const map = doc.get(section);
  if (!isMap(map) || !map.has(key)) {
    const existing = isMap(map) ? map.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key)) : [];
    throw new BaseEditError("NOT_FOUND", `${where}: no ${label} '${key}'. Existing: ${existing.join(", ") || "(none)"}.`);
  }
  map.delete(key);
  if (map.items.length === 0) doc.delete(section);
}

/**
 * Apply edits in order and return the new file text. Pure: throws
 * BaseEditError on the first problem, including if the result doesn't validate.
 */
export function applyBaseEdits(text: string, edits: BaseEdit[]): string {
  let doc = parseBaseDoc(text);
  // createNode (not `new YAMLMap()`) so the map carries the schema setIn needs to build nested maps
  if (doc.contents === null) doc.contents = doc.createNode({});

  for (const [i, edit] of edits.entries()) {
    const where = `edit ${i + 1} (${edit.type})`;
    switch (edit.type) {
      case "set_filters": {
        const path = edit.view !== undefined ? ["views", viewIndex(doc, edit.view, where), "filters"] : ["filters"];
        if (edit.filters === null) doc.deleteIn(path);
        else doc.setIn(path, doc.createNode(edit.filters));
        break;
      }
      case "set_formula":
        doc.setIn(["formulas", edit.name], edit.expression);
        break;
      case "remove_formula":
        deleteAndPrune(doc, "formulas", edit.name, where, "formula");
        break;
      case "set_property":
        doc.setIn(["properties", edit.property, "displayName"], edit.display_name);
        break;
      case "remove_property":
        deleteAndPrune(doc, "properties", edit.property, where, "property");
        break;
      case "add_view": {
        const name = String(edit.view.name ?? "");
        if (viewNames(doc).includes(name)) {
          throw new BaseEditError("ALREADY_EXISTS", `${where}: a view named '${name}' already exists. Use update_view to change it.`);
        }
        if (!isSeq(doc.get("views"))) doc.set("views", new YAMLSeq());
        (doc.get("views") as YAMLSeq).add(doc.createNode(edit.view));
        break;
      }
      case "update_view": {
        if (!edit.set && !edit.remove) throw new BaseEditError("INVALID_ARGS", `${where}: provide set and/or remove.`);
        const idx = viewIndex(doc, edit.name, where);
        const newName = edit.set?.name;
        if (typeof newName === "string" && newName !== edit.name && viewNames(doc).includes(newName)) {
          throw new BaseEditError("ALREADY_EXISTS", `${where}: cannot rename to '${newName}' — that view already exists.`);
        }
        for (const [k, v] of Object.entries(edit.set ?? {})) {
          if (v === null) doc.deleteIn(["views", idx, k]);
          else doc.setIn(["views", idx, k], doc.createNode(v));
        }
        for (const k of edit.remove ?? []) {
          if (k === "type" || k === "name") throw new BaseEditError("INVALID_ARGS", `${where}: '${k}' is required on a view and can't be removed.`);
          doc.deleteIn(["views", idx, k]);
        }
        break;
      }
      case "remove_view":
        doc.deleteIn(["views", viewIndex(doc, edit.name, where)]);
        break;
      case "replace_yaml":
        doc = parseBaseDoc(edit.yaml);
        break;
    }
  }

  const problems = validateBase(doc.toJS());
  if (problems.length) {
    throw new BaseEditError(
      "INVALID_BASE",
      `Edits would produce an invalid base, nothing was written:\n- ${problems.join("\n- ")}\nView types: ${VIEW_TYPES.join(", ")}; filters are an expression string or {and|or|not: [...]}.`,
    );
  }
  return doc.toString();
}
