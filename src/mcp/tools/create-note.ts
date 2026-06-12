import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok, fail } from "../respond.ts";
import { notePayload } from "../note-io.ts";
import { buildNote } from "../../vault/frontmatter.ts";
import { noteTitle } from "../../vault/markdown.ts";
import { applyTemplateVars } from "../../vault/obsidian-config.ts";
import { safeWritePath, withMdExtension } from "../../vault/paths.ts";

export function registerCreateNote(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a new note. Folders are created automatically; '.md' is appended if missing. " +
        "Pass structured `frontmatter` instead of hand-writing a YAML block in `content`. " +
        "`template` instantiates a template from the vault's template folder by name (see vault_info) with {{date}}, {{time}}, {{title}} substituted; `content` is appended after the template body. " +
        "If the path exists you get an error — to modify an existing note use edit_note; to force a sibling, retry with if_exists:'unique'.",
      inputSchema: {
        path: z.string().describe("Vault-relative path, e.g. 'Projects/New Idea' → Projects/New Idea.md"),
        content: z.string().optional().describe("Markdown body (no frontmatter block)."),
        frontmatter: z.record(z.unknown()).optional().describe("Frontmatter as a JSON object, serialized to YAML."),
        template: z.string().optional().describe("Template name (e.g. 'Meeting') or vault path."),
        if_exists: z.enum(["error", "unique"]).default("error").describe("'unique' appends ' 1', ' 2'… like Obsidian."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    guarded(async (args) => {
      let rel = withMdExtension(safeWritePath(args.path));

      let body = args.content ?? "";
      let templater = false;
      if (args.template) {
        const settings = ctx.settings();
        const candidates = [
          args.template,
          withMdExtension(args.template),
          settings.templatesFolder ? `${settings.templatesFolder}/${withMdExtension(args.template)}` : null,
        ].filter((c): c is string => c !== null);
        let templateText: string | null = null;
        for (const cand of candidates) {
          try {
            if (ctx.store.exists(cand) && !ctx.store.isDirectory(cand)) {
              templateText = (await ctx.store.readText(cand)).text;
              break;
            }
          } catch {}
        }
        if (templateText === null) {
          return fail(
            "NOT_FOUND",
            `Template '${args.template}' not found${settings.templatesFolder ? ` in ${settings.templatesFolder}/` : ""}. vault_info lists available templates.`,
          );
        }
        const title = noteTitle(rel, null, "");
        templater = /<%[\s\S]*?%>/.test(templateText);
        const instantiated = applyTemplateVars(templateText, title, ctx.now());
        body = args.content ? `${instantiated.replace(/\n+$/, "\n")}\n${args.content}` : instantiated;
      }

      const text = buildNote(args.frontmatter as Record<string, unknown> | undefined, body);

      if (args.if_exists === "unique" && ctx.store.exists(rel)) {
        const stem = rel.replace(/\.md$/i, "");
        for (let i = 1; ; i++) {
          const cand = `${stem} ${i}.md`;
          if (!ctx.store.exists(cand)) {
            rel = cand;
            break;
          }
        }
      }

      try {
        await ctx.store.write(rel, text, { mustNotExist: true });
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "ALREADY_EXISTS") {
          const existing = await ctx.store.readText(rel);
          return fail(
            "ALREADY_EXISTS",
            `Note already exists at ${rel} (hash ${existing.hash}). To modify it: read_note then edit_note. To force a new sibling note: retry with if_exists:'unique'.`,
          );
        }
        throw err;
      }
      ctx.snapshotter.noteMutation(`mcp: create_note ${rel}`);
      const payload = await notePayload(ctx, rel, { includeBody: false });
      return ok({
        ...payload,
        created: true,
        ...(templater
          ? { note: "Template contains Templater syntax (<% %>) which this server does not execute; it was copied verbatim." }
          : {}),
      });
    }),
  );
}
