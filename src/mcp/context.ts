import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultStore } from "../vault/store.ts";
import type { LinkIndex } from "../vault/links.ts";
import type { Snapshotter } from "../snapshots/snapshotter.ts";
import { readObsidianSettings, type ObsidianSettings } from "../vault/obsidian-config.ts";

/** Cap on AGENTS.md folded into server instructions, so a huge file can't dominate the prompt. */
const MAX_AGENTS_CHARS = 8000;

/**
 * The owner's in-vault agent guide. Agent tooling conventionally puts usage
 * conventions in a top-level AGENTS.md; we surface it read-only in the MCP
 * server instructions. Re-read per call — it may change via sync.
 */
export function readVaultAgentsGuide(vaultDir: string): string | null {
  try {
    const path = join(vaultDir, "AGENTS.md");
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    if (!text) return null;
    return text.length > MAX_AGENTS_CHARS ? `${text.slice(0, MAX_AGENTS_CHARS)}\n…(truncated)` : text;
  } catch {
    return null;
  }
}

/** Everything a tool handler needs. One instance per process. */
export interface VaultContext {
  store: VaultStore;
  links: LinkIndex;
  snapshotter: Snapshotter;
  vaultName: string;
  settings(): ObsidianSettings;
  now(): Date;
  /** Owner-supplied guidance on how to use this vault (conventions, plugins). */
  ownerGuidance(): string | null;
  /** The vault's top-level AGENTS.md, if present (in-vault, synced). */
  vaultGuide(): string | null;
}

export function createVaultContext(args: {
  store: VaultStore;
  links: LinkIndex;
  snapshotter: Snapshotter;
  vaultName?: string;
  now?: () => Date;
  ownerGuidance?: () => string | null;
  vaultGuide?: () => string | null;
}): VaultContext {
  return {
    store: args.store,
    links: args.links,
    snapshotter: args.snapshotter,
    vaultName: args.vaultName ?? "Vault",
    settings: () => readObsidianSettings(args.store.vaultDir),
    now: args.now ?? (() => new Date()),
    ownerGuidance: args.ownerGuidance ?? (() => null),
    vaultGuide: args.vaultGuide ?? (() => readVaultAgentsGuide(args.store.vaultDir)),
  };
}
