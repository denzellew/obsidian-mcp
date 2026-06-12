import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok, fail } from "../respond.ts";
import { notePayload } from "../note-io.ts";
import { applyTemplateVars, dailyNotePath, formatMoment } from "../../vault/obsidian-config.ts";
import { appendUnderHeading } from "../../vault/markdown.ts";
import { parseNote } from "../../vault/frontmatter.ts";

function resolveDate(input: string, now: Date): Date | null {
  switch (input) {
    case "today":
      return now;
    case "yesterday":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    case "tomorrow":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    default: {
      const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
}

export function registerDailyNote(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "daily_note",
    {
      title: "Daily note",
      description:
        "Read or append to a daily journal note, honoring the vault's own daily-note settings (folder, date format, template) — NEVER construct daily-note paths by hand; this tool resolves them exactly as Obsidian does. " +
        "{action:'append', content:'- 14:30 shipped the release'} is the one-call way to log something to today's note, creating it from the user's template if needed. " +
        "Use `heading` to append under a specific section (created at the end of the note if missing). Append is safe without a prior read. " +
        "Reading returns the note's `hash` for edit_note if you need more than an append.",
      inputSchema: {
        date: z.string().default("today").describe("'today', 'yesterday', 'tomorrow', or 'YYYY-MM-DD'."),
        action: z.enum(["read", "append"]).default("read"),
        content: z.string().optional().describe("Required for append."),
        heading: z.string().optional().describe("Append under this section, e.g. 'Log'."),
        create_if_missing: z.boolean().default(true).describe("Create from the daily-note template when absent."),
      },
      annotations: { destructiveHint: false },
    },
    guarded(async (args) => {
      const date = resolveDate(args.date, ctx.now());
      if (!date) return fail("INVALID_ARGS", `Invalid date '${args.date}'. Use 'today', 'yesterday', 'tomorrow', or 'YYYY-MM-DD'.`);
      const settings = ctx.settings();

      let rel: string;
      try {
        rel = dailyNotePath(settings, date);
      } catch (err) {
        return fail(
          "CONFIG_ERROR",
          `The vault's daily-note date format '${settings.dailyNotes.format}' uses tokens this server doesn't support: ${err instanceof Error ? err.message : err}`,
        );
      }

      let created = false;
      if (!ctx.store.exists(rel)) {
        if (!args.create_if_missing) {
          return fail("NOT_FOUND", `No daily note for ${formatMoment(date, "YYYY-MM-DD")} (would be ${rel}). Pass create_if_missing:true to create it.`);
        }
        let initial = "";
        if (settings.dailyNotes.template && ctx.store.exists(settings.dailyNotes.template)) {
          const tpl = (await ctx.store.readText(settings.dailyNotes.template)).text;
          const title = rel.split("/").pop()!.replace(/\.md$/i, "");
          initial = applyTemplateVars(tpl, title, date);
        }
        await ctx.store.write(rel, initial, { mustNotExist: true });
        created = true;
        ctx.snapshotter.noteMutation(`mcp: daily_note create ${rel}`);
      }

      let appended = false;
      if (args.action === "append") {
        if (!args.content) return fail("INVALID_ARGS", "action:'append' requires `content`.");
        // append needs no caller-supplied hash: read+conditional-write with
        // retry makes it safe against concurrent changes elsewhere in the file
        for (let attempt = 1; ; attempt++) {
          const file = await ctx.store.readText(rel);
          const { body } = parseNote(file.text);
          const fmBlock = file.text.slice(0, file.text.length - body.length);
          let newBody: string;
          if (args.heading) {
            ({ body: newBody } = appendUnderHeading(body, args.heading, args.content));
          } else {
            const base = body.replace(/\n+$/, "");
            newBody = `${base.length ? `${base}\n` : ""}${args.content.replace(/\n+$/, "")}\n`;
          }
          try {
            await ctx.store.write(rel, fmBlock + newBody, { expectedHash: file.hash });
            break;
          } catch (err) {
            const stale = err instanceof Error && "code" in err && (err as { code: string }).code === "STALE_NOTE";
            if (!stale || attempt >= 3) throw err;
          }
        }
        appended = true;
        ctx.snapshotter.noteMutation(`mcp: daily_note append ${rel}`);
      }

      const payload = await notePayload(ctx, rel, { includeBody: args.action === "read" });
      return ok({ ...payload, created, appended });
    }),
  );
}
