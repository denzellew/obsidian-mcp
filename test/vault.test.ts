import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { safePath, safeWritePath, VaultPathError, withMdExtension } from "../src/vault/paths.ts";
import { VaultStore, VaultError, contentHash } from "../src/vault/store.ts";
import { parseNote, patchFrontmatter, buildNote } from "../src/vault/frontmatter.ts";
import {
  outline,
  findSection,
  appendUnderHeading,
  replaceSection,
  extractInlineTags,
  frontmatterTags,
  noteTitle,
} from "../src/vault/markdown.ts";
import {
  readObsidianSettings,
  formatMoment,
  dailyNotePath,
  applyTemplateVars,
} from "../src/vault/obsidian-config.ts";
import { parseLinks, LinkIndex, rewriteLinks } from "../src/vault/links.ts";
import { searchVault, SearchError } from "../src/vault/search.ts";
import { fixtureVault, tmpVault, type TmpVault } from "./helpers.ts";

describe("safePath", () => {
  test("normalizes and accepts ordinary paths", () => {
    expect(safePath("Projects/Foo.md")).toBe("Projects/Foo.md");
    expect(safePath("./Projects//Foo.md")).toBe("Projects/Foo.md");
    expect(safePath("/leading/slash.md")).toBe("leading/slash.md");
    expect(safePath("")).toBe("");
  });
  test("rejects traversal and null bytes", () => {
    expect(() => safePath("../escape.md")).toThrow(VaultPathError);
    expect(() => safePath("a/../../b.md")).toThrow(VaultPathError);
    expect(() => safePath("a\0b")).toThrow(VaultPathError);
  });
  test("write rejects protected dirs", () => {
    expect(() => safeWritePath(".obsidian/app.json")).toThrow(VaultPathError);
    expect(() => safeWritePath(".git/config")).toThrow(VaultPathError);
    expect(() => safeWritePath(".trash/x.md")).toThrow(VaultPathError);
    expect(safeWritePath(".trash/x.md", { allowTrash: true })).toBe(".trash/x.md");
  });
  test("md extension helper", () => {
    expect(withMdExtension("Foo")).toBe("Foo.md");
    expect(withMdExtension("Foo.md")).toBe("Foo.md");
    expect(withMdExtension("img.png")).toBe("img.png");
  });
});

describe("VaultStore", () => {
  let vault: TmpVault;
  let store: VaultStore;
  beforeEach(() => {
    vault = fixtureVault();
    store = new VaultStore(vault.dir);
  });
  afterEach(() => vault.cleanup());

  test("read returns content, hash, stat", async () => {
    const f = await store.readText("Reference/Proxmox.md");
    expect(f.text).toContain("Hypervisor");
    expect(f.hash).toHaveLength(12);
    expect(f.stat.size_bytes).toBeGreaterThan(0);
  });

  test("write + read round-trip", async () => {
    const { hash } = await store.write("New/Note.md", "hello\n");
    const back = await store.readText("New/Note.md");
    expect(back.text).toBe("hello\n");
    expect(back.hash).toBe(hash);
  });

  test("stale write rejected with STALE_NOTE", async () => {
    const f = await store.readText("Inbox.md");
    // simulate the sync daemon changing the file
    vault.write("Inbox.md", "changed externally\n");
    await expect(store.write("Inbox.md", "mine\n", { expectedHash: f.hash })).rejects.toMatchObject({
      code: "STALE_NOTE",
    });
  });

  test("write with matching hash succeeds", async () => {
    const f = await store.readText("Inbox.md");
    const r = await store.write("Inbox.md", "updated\n", { expectedHash: f.hash });
    expect(r.hash).toBe(contentHash("updated\n"));
  });

  test("mustNotExist", async () => {
    await expect(store.write("Inbox.md", "x", { mustNotExist: true })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });

  test("trash moves to .trash and uniquifies", async () => {
    vault.write("Old Note.md", "newer doc\n");
    const r = await store.trash("Old Note.md");
    // ".trash/Old Note.md" already exists in fixture
    expect(r.trashedTo).toBe(".trash/Old Note 1.md");
    expect(store.exists("Old Note.md")).toBe(false);
  });

  test("move refuses overwrite unless asked", async () => {
    await expect(store.move("Inbox.md", "Reference/Proxmox.md")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await store.move("Inbox.md", "Reference/Proxmox.md", { overwrite: true });
    expect(store.exists("Inbox.md")).toBe(false);
  });

  test("list hides protected dirs at root", () => {
    const names = store.list("").map((e) => e.name);
    expect(names).not.toContain(".obsidian");
    expect(names).not.toContain(".trash");
    expect(names).toContain("Projects");
  });

  test("list .trash explicitly works", () => {
    const entries = store.list(".trash", { includeHidden: true });
    expect(entries.map((e) => e.name)).toContain("Old Note.md");
  });

  test("walkFiles skips protected dirs", () => {
    const paths = [...store.walkFiles()].map((f) => f.path);
    expect(paths.some((p) => p.startsWith(".obsidian"))).toBe(false);
    expect(paths).toContain("Projects/Home Lab.md");
    expect(paths).toContain("Attachments/rack.png");
  });
});

describe("frontmatter", () => {
  const doc = "---\ntitle: Test\ntags: [a, b]\n# keep me\nstatus: active\n---\nBody line.\n";

  test("parseNote splits fm and body", () => {
    const p = parseNote(doc);
    expect(p.frontmatter).toMatchObject({ title: "Test", status: "active" });
    expect(p.body).toBe("Body line.\n");
  });

  test("no frontmatter", () => {
    const p = parseNote("just body");
    expect(p.frontmatter).toBeNull();
    expect(p.body).toBe("just body");
  });

  test("patch preserves order and comments, body untouched", () => {
    const out = patchFrontmatter(doc, { set: { status: "done", priority: 1 } });
    expect(out).toContain("# keep me");
    expect(out.indexOf("title:")).toBeLessThan(out.indexOf("status:"));
    expect(out).toContain("status: done");
    expect(out).toContain("priority: 1");
    expect(out.endsWith("Body line.\n")).toBe(true);
  });

  test("patch creates block when missing", () => {
    const out = patchFrontmatter("body only\n", { set: { x: 1 } });
    expect(out.startsWith("---\nx: 1\n---\n")).toBe(true);
  });

  test("removing last key removes block", () => {
    const out = patchFrontmatter("---\nonly: 1\n---\nbody\n", { remove: ["only"] });
    expect(out).toBe("body\n");
  });

  test("buildNote", () => {
    expect(buildNote({ a: 1 }, "b\n")).toBe("---\na: 1\n---\nb\n");
    expect(buildNote(undefined, "b\n")).toBe("b\n");
  });
});

describe("markdown structure", () => {
  const body = "# Top\n\nintro\n\n## Tasks\n- [ ] one\n\n```\n## not a heading\n```\n\n## Log\n- entry\n\n### Sub\ndeep\n";

  test("outline skips fences", () => {
    const h = outline(body).map((x) => x.text);
    expect(h).toEqual(["Top", "Tasks", "Log", "Sub"]);
  });

  test("findSection spans to next same-or-higher heading", () => {
    const s = findSection(body, "Tasks")!;
    const lines = body.split("\n");
    expect(lines[s.start]).toBe("## Tasks");
    expect(lines.slice(s.start, s.end).join("\n")).toContain("- [ ] one");
    expect(lines.slice(s.start, s.end).join("\n")).not.toContain("## Log");
  });

  test("findSection includes subsections", () => {
    const s = findSection(body, "Log")!;
    expect(body.split("\n").slice(s.start, s.end).join("\n")).toContain("### Sub");
  });

  test("appendUnderHeading existing", () => {
    const { body: out, created } = appendUnderHeading(body, "Tasks", "- [ ] two");
    expect(created).toBe(false);
    const s = findSection(out, "Tasks")!;
    expect(out.split("\n").slice(s.start, s.end).join("\n")).toContain("- [ ] two");
  });

  test("appendUnderHeading creates missing heading", () => {
    const { body: out, created } = appendUnderHeading("text\n", "Ideas", "- new idea");
    expect(created).toBe(true);
    expect(out).toContain("## Ideas");
    expect(out).toContain("- new idea");
  });

  test("replaceSection", () => {
    const out = replaceSection(body, "Tasks", "- [x] done")!;
    expect(out).toContain("## Tasks\n- [x] done");
    expect(out).not.toContain("- [ ] one");
    expect(replaceSection(body, "Nope", "x")).toBeNull();
  });

  test("inline tags", () => {
    const tags = extractInlineTags("work on #project/acme and #infra but not `#code` or\n```\n#fenced\n```\nnot#midword");
    expect(tags).toContain("project/acme");
    expect(tags).toContain("infra");
    expect(tags).not.toContain("code");
    expect(tags).not.toContain("fenced");
    expect(tags).not.toContain("midword");
  });

  test("frontmatter tags normalize", () => {
    expect(frontmatterTags({ tags: ["a", "#b"] })).toEqual(["a", "b"]);
    expect(frontmatterTags({ tags: "x, y" })).toEqual(["x", "y"]);
    expect(frontmatterTags(null)).toEqual([]);
  });

  test("noteTitle precedence", () => {
    expect(noteTitle("a/B.md", { title: "FM" }, "# H1\n")).toBe("FM");
    expect(noteTitle("a/B.md", null, "# H1\n")).toBe("H1");
    expect(noteTitle("a/B.md", null, "no heading")).toBe("B");
  });
});

describe("obsidian config", () => {
  let vault: TmpVault;
  beforeEach(() => (vault = fixtureVault()));
  afterEach(() => vault.cleanup());

  test("reads settings", () => {
    const s = readObsidianSettings(vault.dir);
    expect(s.dailyNotes.folder).toBe("Journal");
    expect(s.dailyNotes.template).toBe("Templates/Daily.md");
    expect(s.templatesFolder).toBe("Templates");
    expect(s.newLinkFormat).toBe("shortest");
    expect(s.attachmentFolder).toBe("Attachments");
  });

  test("defaults when missing", () => {
    const empty = tmpVault();
    const s = readObsidianSettings(empty.dir);
    expect(s.dailyNotes.format).toBe("YYYY-MM-DD");
    expect(s.dailyNotes.folder).toBe("");
    empty.cleanup();
  });

  test("formatMoment", () => {
    const d = new Date(2026, 5, 12, 9, 5, 7); // June 12 2026, Friday
    expect(formatMoment(d, "YYYY-MM-DD")).toBe("2026-06-12");
    expect(formatMoment(d, "YYYY/MM/YYYY-MM-DD ddd")).toBe("2026/06/2026-06-12 Fri");
    expect(formatMoment(d, "[Week of] MMMM D")).toBe("Week of June 12");
    expect(formatMoment(d, "HH:mm")).toBe("09:05");
    expect(() => formatMoment(d, "gggg-ww")).toThrow(/Unsupported/);
  });

  test("dailyNotePath", () => {
    const s = readObsidianSettings(vault.dir);
    expect(dailyNotePath(s, new Date(2026, 5, 12))).toBe("Journal/2026-06-12.md");
  });

  test("applyTemplateVars", () => {
    const out = applyTemplateVars("# {{date}} {{time}} — {{title}}", "My Note", new Date(2026, 5, 12, 14, 30));
    expect(out).toBe("# 2026-06-12 14:30 — My Note");
    expect(applyTemplateVars("{{date:YYYY}}", "t", new Date(2026, 0, 1))).toBe("2026");
  });
});

describe("links", () => {
  let vault: TmpVault;
  let store: VaultStore;
  let index: LinkIndex;
  beforeEach(async () => {
    vault = fixtureVault();
    store = new VaultStore(vault.dir);
    index = new LinkIndex(store);
    await index.refresh();
  });
  afterEach(() => vault.cleanup());

  test("parseLinks finds wiki, alias, heading, embed, md links", () => {
    const links = parseLinks(
      "See [[Foo]] and [[Bar#Sec|alias]] and ![[img.png]] and [text](Some%20Note.md) but not [ext](https://x.com)\n```\n[[fenced]]\n```\n",
    );
    expect(links).toHaveLength(4);
    expect(links[0]).toMatchObject({ target: "Foo", style: "wiki", embed: false });
    expect(links[1]).toMatchObject({ target: "Bar", heading: "Sec", alias: "alias" });
    expect(links[2]).toMatchObject({ target: "img.png", embed: true });
    expect(links[3]).toMatchObject({ target: "Some Note.md", style: "markdown" });
  });

  test("resolve bare name shortest-path", () => {
    expect(index.resolve("Proxmox")).toBe("Reference/Proxmox.md");
    expect(index.resolve("Home Lab")).toBe("Projects/Home Lab.md");
    expect(index.resolve("home lab")).toBe("Projects/Home Lab.md"); // case-insensitive
    expect(index.resolve("Nope")).toBeNull();
  });

  test("resolve path targets and attachments", () => {
    expect(index.resolve("Reference/Networking")).toBe("Reference/Networking.md");
    expect(index.resolve("Attachments/rack.png")).toBe("Attachments/rack.png");
  });

  test("backlinks", () => {
    const back = index.backlinks("Projects/Home Lab.md");
    const sources = back.map((b) => b.source).sort();
    expect(sources).toEqual(["Inbox.md", "Journal/2026-06-10.md"]);
  });

  test("outgoing includes embeds and unresolved", () => {
    const out = index.outgoing("Projects/Home Lab.md");
    expect(out.find((l) => l.target === "Proxmox")?.resolved).toBe("Reference/Proxmox.md");
    expect(out.find((l) => l.embed)?.target).toBe("Attachments/rack.png");
  });

  test("rewriteLinks on move (shortest format)", async () => {
    const journal = await store.readText("Journal/2026-06-10.md");
    const out = rewriteLinks(
      journal.text,
      "Journal/2026-06-10.md",
      "Projects/Home Lab.md",
      "Archive/Home Lab 2026.md",
      "shortest",
      index,
    );
    expect(out).toContain("[[Home Lab 2026]]");
    expect(out).not.toContain("[[Home Lab]]");
  });

  test("rewriteLinks rewrites markdown links with encoding", async () => {
    const inbox = await store.readText("Inbox.md");
    const out = rewriteLinks(inbox.text, "Inbox.md", "Projects/Home Lab.md", "Projects/The Lab.md", "absolute", index);
    expect(out).toContain("(Projects/The%20Lab.md)");
  });

  test("rewriteLinks returns null when nothing to change", async () => {
    const prox = await store.readText("Reference/Proxmox.md");
    expect(rewriteLinks(prox.text, "Reference/Proxmox.md", "Projects/Home Lab.md", "X.md", "shortest", index)).toBeNull();
  });
});

describe("search", () => {
  let vault: TmpVault;
  let store: VaultStore;
  beforeEach(() => {
    vault = fixtureVault();
    store = new VaultStore(vault.dir);
  });
  afterEach(() => vault.cleanup());

  test("literal content search with highlight", async () => {
    const r = await searchVault(store, { query: "proxmox" });
    expect(r.total_notes).toBeGreaterThanOrEqual(2);
    const lab = r.results.find((n) => n.path === "Projects/Home Lab.md")!;
    expect(lab.matches[0]!.text).toContain("«proxmox»");
    expect(lab.title).toBe("Home Lab");
  });

  test("filename scope", async () => {
    const r = await searchVault(store, { query: "rack", scope: ["filename"] });
    expect(r.results.map((n) => n.path)).toContain("Attachments/rack.png");
  });

  test("tag filter incl. nested + frontmatter", async () => {
    const r = await searchVault(store, { tag: "infra" });
    const paths = r.results.map((n) => n.path).sort();
    expect(paths).toEqual(["Projects/Home Lab.md", "Reference/Proxmox.md"]);
  });

  test("tag + query compose", async () => {
    const r = await searchVault(store, { query: "cluster", tag: "project" });
    expect(r.results.map((n) => n.path)).toEqual(["Projects/Home Lab.md"]);
  });

  test("folder filter", async () => {
    const r = await searchVault(store, { query: "Proxmox", folder: "Reference" });
    expect(r.results.every((n) => n.path.startsWith("Reference/"))).toBe(true);
  });

  test("invalid regex is a teaching error", async () => {
    await expect(searchVault(store, { query: "([", regex: true })).rejects.toThrow(SearchError);
  });

  test("pagination cursor", async () => {
    for (let i = 0; i < 5; i++) vault.write(`Bulk/note-${i}.md`, "common term here\n");
    const page1 = await searchVault(store, { query: "common term", maxResults: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page1.truncated).toBe(true);
    const page2 = await searchVault(store, { query: "common term", maxResults: 2, cursor: page1.next_cursor });
    expect(page2.results[0]!.path).not.toBe(page1.results[0]!.path);
  });

  test("requires query or tag", async () => {
    await expect(searchVault(store, {})).rejects.toThrow(/query/);
  });
});
