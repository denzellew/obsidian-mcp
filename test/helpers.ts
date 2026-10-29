import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "../src/config.ts";
import { vaultSettings } from "../src/db/index.ts";
import type { VaultContext } from "../src/mcp/context.ts";
import { DEFAULT_VAULT_ID, VaultRegistry } from "../src/vaults/registry.ts";

export interface TmpVault {
  dir: string;
  write(relPath: string, content: string): void;
  cleanup(): void;
}

/** Create a throwaway vault directory with optional seed files. */
export function tmpVault(files: Record<string, string> = {}): TmpVault {
  const dir = mkdtempSync(join(tmpdir(), "obmcp-vault-"));
  const write = (relPath: string, content: string) => {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [p, c] of Object.entries(files)) write(p, c);
  return {
    dir,
    write,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A representative vault used across suites. */
export function fixtureVault(): TmpVault {
  return tmpVault({
    "Projects/Home Lab.md": [
      "---",
      "tags: [project, infra]",
      "status: active",
      "---",
      "# Home Lab",
      "",
      "Rebuild the proxmox cluster. See [[Proxmox]] and [[Reference/Networking#VLANs|vlan notes]].",
      "",
      "## Tasks",
      "- [ ] order switch",
      "",
      "## Log",
      "- 2026-06-01 started planning #homelab",
      "",
      "![[Attachments/rack.png]]",
    ].join("\n"),
    "Reference/Proxmox.md": "# Proxmox\n\nHypervisor notes. #infra\n",
    "Reference/Networking.md": "# Networking\n\n## VLANs\n\nVLAN layout.\n",
    "Journal/2026-06-10.md": "Made progress on [[Home Lab]] networking today. #journal\n",
    "Inbox.md": "Quick captures.\n\n- [markdown link](Projects/Home%20Lab.md) to the lab\n",
    "Attachments/rack.png": "\x89PNG fake",
    ".obsidian/app.json": JSON.stringify({ newLinkFormat: "shortest", useMarkdownLinks: false, attachmentFolderPath: "Attachments" }),
    ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "Templates/Daily" }),
    ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    ".obsidian/core-plugins.json": JSON.stringify({ "file-explorer": true, "daily-notes": true, graph: false }),
    ".obsidian/community-plugins.json": JSON.stringify(["dataview", "obsidian-tasks-plugin"]),
    ".obsidian/plugins/dataview/manifest.json": JSON.stringify({ id: "dataview", name: "Dataview", version: "0.5.64", description: "Query your notes.", author: "blacksmithgu" }),
    ".obsidian/appearance.json": JSON.stringify({ theme: "obsidian", cssTheme: "Minimal", baseFontSize: 16, enabledCssSnippets: ["tweaks"] }),
    ".obsidian/hotkeys.json": JSON.stringify({ "editor:toggle-bold": [{ modifiers: ["Mod"], key: "B" }] }),
    "Templates/Daily.md": "# {{date}}\n\n## Log\n\n## Notes\n",
    ".trash/Old Note.md": "deleted content\n",
  });
}

/** A registry holding just the default vault, for tests that build their own context. */
export function singleVault(config: Config, db: Database, ctx: VaultContext): VaultRegistry {
  return new VaultRegistry([
    { id: DEFAULT_VAULT_ID, slug: "default", name: "Vault", config, ctx, settings: vaultSettings(db, DEFAULT_VAULT_ID) },
  ]);
}
