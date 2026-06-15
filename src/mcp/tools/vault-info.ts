import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { dailyNotePath, readVaultConfig } from "../../vault/obsidian-config.ts";
import { isMarkdown } from "../../vault/paths.ts";

export function registerVaultInfo(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "vault_info",
    {
      title: "Vault info",
      description:
        "Orientation for this vault — call this FIRST in a session. Returns note/attachment/folder counts, the daily-notes configuration (folder, date format, whether today's note exists), available templates, attachment folder, link-format settings, a summary of installed plugins, and the most recently modified notes. " +
        "Use it to learn where things live before creating or searching. If plugins are listed, call vault_config for the full setup (versions, theme, hotkeys).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const settings = ctx.settings();
      let notes = 0;
      let attachments = 0;
      let totalBytes = 0;
      const folders = new Set<string>();
      const recent: { path: string; modified: string }[] = [];

      for (const file of ctx.store.walkFiles()) {
        let stat;
        try {
          stat = ctx.store.stat(file.path);
        } catch {
          continue;
        }
        if (isMarkdown(file.path)) notes++;
        else attachments++;
        totalBytes += stat.size_bytes;
        const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        if (dir) folders.add(dir);
        if (isMarkdown(file.path)) {
          recent.push({ path: file.path, modified: stat.modified });
        }
      }
      recent.sort((a, b) => b.modified.localeCompare(a.modified));

      let templates: string[] = [];
      if (settings.templatesFolder && ctx.store.exists(settings.templatesFolder)) {
        try {
          templates = ctx.store
            .list(settings.templatesFolder)
            .filter((e) => e.type === "note")
            .map((e) => e.name.replace(/\.md$/i, ""));
        } catch {}
      }

      let todayPath: string | null = null;
      let dailyFormatError: string | null = null;
      try {
        todayPath = dailyNotePath(settings, ctx.now());
      } catch (err) {
        dailyFormatError = err instanceof Error ? err.message : String(err);
      }

      const cfg = readVaultConfig(ctx.store.vaultDir);
      const enabledCommunity = cfg.communityPlugins.filter((p) => p.enabled);

      return ok({
        vault_name: ctx.vaultName,
        counts: { notes, attachments, folders: folders.size, total_bytes: totalBytes },
        daily_notes: {
          enabled: settings.dailyNotes.enabled,
          folder: settings.dailyNotes.folder,
          format: settings.dailyNotes.format,
          template: settings.dailyNotes.template,
          ...(todayPath
            ? { today_path: todayPath, today_exists: ctx.store.exists(todayPath) }
            : { format_error: dailyFormatError }),
        },
        templates: { folder: settings.templatesFolder, names: templates },
        attachment_folder: settings.attachmentFolder,
        link_format: settings.newLinkFormat,
        uses_markdown_links: settings.useMarkdownLinks,
        plugins: {
          core_enabled: cfg.corePlugins.length,
          community_enabled: enabledCommunity.length,
          community_names: enabledCommunity.map((p) => p.name),
          hint: enabledCommunity.length ? "Call vault_config for versions, theme, and hotkeys." : undefined,
        },
        recently_modified: recent.slice(0, 5),
        ...(ctx.ownerGuidance()?.trim() ? { owner_guidance: ctx.ownerGuidance()!.trim() } : {}),
      });
    }),
  );
}
