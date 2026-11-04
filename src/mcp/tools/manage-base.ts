import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { fail, guarded, ok } from "../respond.ts";
import { applyBaseEdits, buildBase, parseBaseDoc, summarizeBase, VIEW_TYPES, type BaseEdit, type Filter } from "../../vault/bases.ts";
import { isBase, safePath, safeWritePath, withExtension } from "../../vault/paths.ts";
import { VaultError } from "../../vault/store.ts";

// Kept deliberately loose (no recursive schema) so the published JSON Schema
// stays simple; structure is enforced by validateBase with teaching errors.
const FilterInput = z
  .union([z.string(), z.record(z.unknown())])
  .describe('Expression string like \'file.hasTag("project")\', or {and|or|not: [filters…]}.');
const ViewInput = z
  .object({ type: z.enum(VIEW_TYPES), name: z.string().min(1) })
  .passthrough()
  .describe("A view: {type, name, filters?, order?: [property ids], sort?: [{property, direction: ASC|DESC}], limit?, groupBy?, …}.");

const EditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_filters"),
    filters: FilterInput.nullable().describe("null removes the filters."),
    view: z.string().optional().describe("Set this view's filters instead of the base-wide ones."),
  }),
  z.object({ type: z.literal("set_formula"), name: z.string().min(1), expression: z.string().min(1) }),
  z.object({ type: z.literal("remove_formula"), name: z.string().min(1) }),
  z.object({
    type: z.literal("set_property"),
    property: z.string().min(1).describe("Property id, e.g. 'note.status', 'file.mtime', 'formula.age'."),
    display_name: z.string(),
  }),
  z.object({ type: z.literal("remove_property"), property: z.string().min(1) }),
  z.object({ type: z.literal("add_view"), view: ViewInput }),
  z.object({
    type: z.literal("update_view"),
    name: z.string().describe("Current view name."),
    set: z.record(z.unknown()).optional().describe("Keys to set on the view (null deletes a key; set.name renames)."),
    remove: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("remove_view"), name: z.string() }),
  z.object({
    type: z.literal("replace_yaml"),
    yaml: z.string().describe("Entire new file content. Requires expected_hash; prefer the structured edits."),
  }),
]);

/** Resolve an existing .base: path with or without the extension, or a wikilink-style name. */
async function resolveBase(ctx: VaultContext, input: string): Promise<string> {
  const rel = withExtension(safePath(input), ".base");
  if (isBase(rel) && ctx.store.exists(rel) && !ctx.store.isDirectory(rel)) return rel;
  const wanted = (rel.split("/").pop() ?? rel).toLowerCase();
  const all = [...ctx.store.walkFiles()].map((f) => f.path).filter(isBase);
  const byName = all.filter((p) => (p.split("/").pop() ?? p).toLowerCase() === wanted).sort((a, b) => a.length - b.length);
  if (byName[0]) return byName[0];
  throw new VaultError(
    "NOT_FOUND",
    `No base found for '${input}'. ${all.length ? `Bases in this vault: ${all.slice(0, 20).join(", ")}.` : "This vault has no .base files yet."} To make one use action:'create'.`,
  );
}

export function registerManageBase(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "manage_base",
    {
      title: "Create or edit an Obsidian Base",
      description:
        "Create or edit Obsidian Bases (.base files): database-like views (table, cards, list, map) over the vault's notes, defined by filters, formulas, property display names, and views. " +
        "Before editing, ALWAYS read_note the .base first and pass its `hash` as expected_hash; the vault syncs continuously. Edits are structured, apply top-to-bottom atomically, and are validated: an invalid result writes nothing. The owner's comments and key order are preserved. " +
        "Property ids: file.name, file.path, file.folder, file.ctime, file.mtime, file.tags, file.links…; note properties as 'note.status' or bare 'status'; formulas as 'formula.<name>'. " +
        'Filter examples: \'file.hasTag("project")\', \'file.inFolder("Projects")\', \'status == "active"\', \'file.mtime > now() - "7d"\'; combine with {and: [...]}, {or: [...]}, {not: [...]}. ' +
        'Formula example: set_formula {name: "age", expression: "(now() - file.ctime) / 86400000"}. ' +
        "Show a base in a note by embedding ![[Name.base]] or ![[Name.base#View name]]. Every mutation is git-snapshotted.",
      inputSchema: {
        path: z.string().describe("Vault-relative path; '.base' is appended if missing. For edit, a bare name like 'Projects' also works."),
        action: z.enum(["create", "edit"]),
        // create
        filters: FilterInput.optional().describe("create: base-wide filters applied to every view."),
        formulas: z.record(z.string()).optional().describe("create: {name: expression}."),
        properties: z.record(z.object({ displayName: z.string().optional() }).passthrough()).optional()
          .describe("create: {propertyId: {displayName}}."),
        views: z.array(ViewInput).optional().describe("create: views; default is one table view named 'Table'."),
        if_exists: z.enum(["error", "unique"]).default("error").describe("create: 'unique' appends ' 1', ' 2'…"),
        // edit
        expected_hash: z.string().optional().describe("edit: hash from read_note. Required for replace_yaml; strongly recommended otherwise."),
        edits: z.array(EditSchema).optional().describe("edit: operations to apply in order."),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    guarded(async (args) => {
      if (args.action === "create") {
        if (args.edits?.length || args.expected_hash) {
          return fail("INVALID_ARGS", "edits/expected_hash are for action:'edit'. For create, pass filters, formulas, properties, views.");
        }
        let rel = withExtension(safeWritePath(args.path), ".base");
        if (!isBase(rel)) return fail("INVALID_ARGS", `A base must have a .base extension (got '${rel}').`);
        // round-trip through applyBaseEdits (no edits) for validation with teaching errors
        const text = applyBaseEdits(
          buildBase({
            filters: args.filters as unknown as Filter | undefined,
            formulas: args.formulas,
            properties: args.properties,
            views: args.views,
          }),
          [],
        );
        if (args.if_exists === "unique" && ctx.store.exists(rel)) {
          const stem = rel.replace(/\.base$/i, "");
          for (let i = 1; ; i++) {
            if (!ctx.store.exists(`${stem} ${i}.base`)) {
              rel = `${stem} ${i}.base`;
              break;
            }
          }
        }
        let result;
        try {
          result = await ctx.store.write(rel, text, { mustNotExist: true });
        } catch (err) {
          if (err instanceof VaultError && err.code === "ALREADY_EXISTS") {
            const existing = await ctx.store.readText(rel);
            return fail(
              "ALREADY_EXISTS",
              `A base already exists at ${rel} (hash ${existing.hash}). To change it: read_note then manage_base action:'edit'. To make a sibling: retry with if_exists:'unique'.`,
            );
          }
          throw err;
        }
        ctx.snapshotter.noteMutation(`mcp: manage_base create ${rel}`);
        return ok({ path: rel, created: true, hash: result.hash, summary: summarizeBase(parseBaseDoc(text).toJS()), embed: `![[${rel.split("/").pop()}]]` });
      }

      // edit
      if (!args.edits?.length) return fail("INVALID_ARGS", "action:'edit' needs a non-empty `edits` array.");
      const edits = args.edits as unknown as BaseEdit[];
      if (!args.expected_hash && edits.some((e) => e.type === "replace_yaml")) {
        return fail("INVALID_ARGS", "replace_yaml requires expected_hash. Call read_note on the base first, pass its `hash`, and prefer structured edits.");
      }
      const rel = await resolveBase(ctx, args.path);
      const file = await ctx.store.readText(rel);
      if (args.expected_hash && args.expected_hash !== file.hash) {
        return fail(
          "STALE_NOTE",
          `'${rel}' changed since you read it (expected ${args.expected_hash}, now ${file.hash} — likely Obsidian Sync). Call read_note('${rel}') and retry against the current content.`,
        );
      }
      const text = applyBaseEdits(file.text, edits);
      const result = await ctx.store.write(rel, text, { expectedHash: file.hash });
      ctx.snapshotter.noteMutation(`mcp: manage_base edit ${rel}`);
      return ok({ path: rel, hash: result.hash, edits_applied: edits.length, summary: summarizeBase(parseBaseDoc(text).toJS()) });
    }),
  );
}
