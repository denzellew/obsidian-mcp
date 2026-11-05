import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { applyBaseEdits, buildBase, BaseEditError, summarizeBase, validateBase } from "../src/vault/bases.ts";

const SAMPLE = `# Project tracker — owner comment
filters:
  and:
    - file.inFolder("Projects")
formulas:
  age: (now() - file.ctime) / 86400000
properties:
  note.status:
    displayName: Status
views:
  - type: table
    name: Active
    order:
      - file.name
      - note.status
  - type: cards
    name: Gallery # keep me
`;

function errorOf(fn: () => unknown): BaseEditError {
  try {
    fn();
  } catch (err) {
    if (err instanceof BaseEditError) return err;
    throw err;
  }
  throw new Error("expected BaseEditError");
}

describe("buildBase", () => {
  test("defaults to one table view and omits empty sections", () => {
    const obj = parse(buildBase({}));
    expect(obj).toEqual({ views: [{ type: "table", name: "Table" }] });
  });

  test("serializes all parts", () => {
    const obj = parse(
      buildBase({
        filters: { or: ['file.hasTag("a")', 'file.hasTag("b")'] },
        formulas: { x: "1 + 1" },
        properties: { "note.x": { displayName: "X" } },
        views: [{ type: "cards", name: "Cards", limit: 10 }],
      }),
    );
    expect(obj.filters.or).toHaveLength(2);
    expect(obj.formulas.x).toBe("1 + 1");
    expect(obj.views[0].limit).toBe(10);
  });
});

describe("validateBase", () => {
  test("accepts a valid base and keeps unknown keys", () => {
    expect(validateBase(parse(SAMPLE))).toEqual([]);
    expect(validateBase({ views: [{ type: "table", name: "T", someFutureKey: { a: 1 } }], summaries: {} })).toEqual([]);
  });

  test("flags bad view type, duplicate names, malformed filters", () => {
    expect(validateBase({ views: [{ type: "kanban", name: "K" }] }).join()).toContain("views.0.type");
    expect(validateBase({ views: [{ type: "table", name: "A" }, { type: "list", name: "A" }] }).join()).toContain("duplicate view name 'A'");
    expect(validateBase({ filters: { xor: ["a"] } }).length).toBeGreaterThan(0);
    expect(validateBase({ filters: { and: [{ or: ["a", 5] }] } }).length).toBeGreaterThan(0);
    expect(validateBase({ views: [{ type: "table", name: "T", sort: [{ property: "file.name", direction: "UP" }] }] }).length).toBeGreaterThan(0);
  });
});

describe("applyBaseEdits", () => {
  test("formula, property, and filter edits preserve comments", () => {
    const out = applyBaseEdits(SAMPLE, [
      { type: "set_formula", name: "overdue", expression: "due < now()" },
      { type: "set_property", property: "formula.age", display_name: "Age (days)" },
      { type: "set_filters", filters: 'status != "done"', view: "Active" },
    ]);
    expect(out).toContain("# Project tracker — owner comment");
    expect(out).toContain("# keep me");
    const obj = parse(out);
    expect(obj.formulas).toEqual({ age: "(now() - file.ctime) / 86400000", overdue: "due < now()" });
    expect(obj.properties["formula.age"]).toEqual({ displayName: "Age (days)" });
    expect(obj.views[0].filters).toBe('status != "done"');
    expect(obj.filters.and).toHaveLength(1); // global untouched
  });

  test("remove ops prune empty sections; set_filters null removes", () => {
    const obj = parse(
      applyBaseEdits(SAMPLE, [
        { type: "remove_formula", name: "age" },
        { type: "remove_property", property: "note.status" },
        { type: "set_filters", filters: null },
      ]),
    );
    expect(obj.formulas).toBeUndefined();
    expect(obj.properties).toBeUndefined();
    expect(obj.filters).toBeUndefined();
  });

  test("view add/update/rename/remove", () => {
    const obj = parse(
      applyBaseEdits(SAMPLE, [
        { type: "add_view", view: { type: "list", name: "Recent", sort: [{ property: "file.mtime", direction: "DESC" }], limit: 5 } },
        { type: "update_view", name: "Active", set: { name: "In progress", limit: 20 }, remove: ["order"] },
        { type: "remove_view", name: "Gallery" },
      ]),
    );
    expect(obj.views.map((v: any) => v.name)).toEqual(["In progress", "Recent"]);
    expect(obj.views[0]).toEqual({ type: "table", name: "In progress", limit: 20 });
    expect(obj.views[1].sort[0].direction).toBe("DESC");
  });

  test("works on an empty file", () => {
    const obj = parse(applyBaseEdits("", [{ type: "add_view", view: { type: "table", name: "T" } }, { type: "set_formula", name: "f", expression: "1" }]));
    expect(obj).toEqual({ views: [{ type: "table", name: "T" }], formulas: { f: "1" } });
  });

  test("teaching errors", () => {
    const missing = errorOf(() => applyBaseEdits(SAMPLE, [{ type: "remove_view", name: "Nope" }]));
    expect(missing.code).toBe("NOT_FOUND");
    expect(missing.message).toContain("Views: Active | Gallery");

    expect(errorOf(() => applyBaseEdits(SAMPLE, [{ type: "add_view", view: { type: "table", name: "Active" } }])).code).toBe("ALREADY_EXISTS");
    expect(errorOf(() => applyBaseEdits(SAMPLE, [{ type: "update_view", name: "Active", set: { name: "Gallery" } }])).code).toBe("ALREADY_EXISTS");
    expect(errorOf(() => applyBaseEdits(SAMPLE, [{ type: "update_view", name: "Active", remove: ["type"] }])).code).toBe("INVALID_ARGS");
    expect(errorOf(() => applyBaseEdits(SAMPLE, [{ type: "remove_formula", name: "zzz" }])).message).toContain("Existing: age");

    const invalid = errorOf(() => applyBaseEdits(SAMPLE, [{ type: "update_view", name: "Active", set: { type: "kanban" } }]));
    expect(invalid.code).toBe("INVALID_BASE");
    expect(invalid.message).toContain("nothing was written");

    expect(errorOf(() => applyBaseEdits("views: [unclosed", [])).code).toBe("INVALID_BASE");
    expect(errorOf(() => applyBaseEdits("- just\n- a list\n", [])).code).toBe("INVALID_BASE");
  });

  test("replace_yaml swaps the whole document", () => {
    const obj = parse(applyBaseEdits(SAMPLE, [{ type: "replace_yaml", yaml: "views:\n  - type: map\n    name: Places\n" }]));
    expect(obj).toEqual({ views: [{ type: "map", name: "Places" }] });
  });
});

describe("summarizeBase", () => {
  test("lists views and formulas", () => {
    expect(summarizeBase(parse(SAMPLE))).toEqual({
      views: [
        { name: "Active", type: "table" },
        { name: "Gallery", type: "cards" },
      ],
      formulas: ["age"],
      has_filters: true,
    });
    expect(summarizeBase(null)).toEqual({ views: [], formulas: [], has_filters: false });
  });
});
