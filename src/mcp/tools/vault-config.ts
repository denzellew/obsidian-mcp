import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../context.ts";
import { guarded, ok } from "../respond.ts";
import { readVaultConfig } from "../../vault/obsidian-config.ts";

export function registerVaultConfig(server: McpServer, ctx: VaultContext) {
  server.registerTool(
    "vault_config",
    {
      title: "Vault config",
      description:
        "Read-only view of the vault owner's Obsidian setup: enabled core plugins, installed community plugins (with versions), the active theme/appearance, and which commands have customized hotkeys. " +
        "Use it to understand how the owner works — e.g. if Dataview, Tasks, or Templater are installed, notes may rely on their syntax. " +
        "This reflects the .obsidian/ config currently on disk (populated when the owner enables config sync); if config is not present, `present` is false and the lists are empty. The MCP server never writes config.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const cfg = readVaultConfig(ctx.store.vaultDir);
      return ok({
        present: cfg.present,
        core_plugins: cfg.corePlugins,
        community_plugins: cfg.communityPlugins.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          enabled: p.enabled,
        })),
        appearance: {
          mode: cfg.appearance.mode,
          css_theme: cfg.appearance.cssTheme,
          accent_color: cfg.appearance.accentColor,
          base_font_size: cfg.appearance.baseFontSize,
          enabled_css_snippets: cfg.appearance.enabledCssSnippets,
        },
        customized_hotkeys: cfg.customizedHotkeys,
      });
    }),
  );
}
