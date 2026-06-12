import type { VaultStore } from "../vault/store.ts";
import type { LinkIndex } from "../vault/links.ts";
import type { Snapshotter } from "../snapshots/snapshotter.ts";
import { readObsidianSettings, type ObsidianSettings } from "../vault/obsidian-config.ts";

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
}

export function createVaultContext(args: {
  store: VaultStore;
  links: LinkIndex;
  snapshotter: Snapshotter;
  vaultName?: string;
  now?: () => Date;
  ownerGuidance?: () => string | null;
}): VaultContext {
  return {
    store: args.store,
    links: args.links,
    snapshotter: args.snapshotter,
    vaultName: args.vaultName ?? "Vault",
    settings: () => readObsidianSettings(args.store.vaultDir),
    now: args.now ?? (() => new Date()),
    ownerGuidance: args.ownerGuidance ?? (() => null),
  };
}
