import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";

/**
 * One-shot invocations of the obsidian-headless `ob` CLI.
 * Everything ob-specific is isolated here — the package is 0.0.x beta and
 * flags may drift; fix them in this file only.
 *
 * ob stores state under $XDG_CONFIG_HOME/obsidian-headless, so we point
 * HOME/XDG_CONFIG_HOME at our data dir to keep it inside ./data.
 */

export interface ObResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function obEnv(config: Config): Record<string, string> {
  return {
    ...process.env,
    HOME: config.obConfigDir,
    XDG_CONFIG_HOME: config.obConfigDir,
  } as Record<string, string>;
}

export async function runOb(config: Config, args: string[], opts: { timeoutMs?: number } = {}): Promise<ObResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config.obBin, ...args], {
      env: obEnv(config),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: `Could not launch '${config.obBin}'. Is obsidian-headless installed? (npm install -g obsidian-headless)`,
    };
  }
  const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

export function obInstalled(config: Config): boolean {
  return Bun.which(config.obBin) !== null;
}

export function obLoggedIn(config: Config): boolean {
  return existsSync(join(config.obConfigDir, "obsidian-headless", "auth_token")) || existsSync(join(config.obConfigDir, ".config", "obsidian-headless", "auth_token")) || existsSync(join(config.obConfigDir, "auth_token"));
}

export async function obLogin(config: Config, email: string, password: string, mfa?: string): Promise<ObResult> {
  const args = ["login", "--email", email, "--password", password];
  if (mfa) args.push("--mfa", mfa);
  return runOb(config, args);
}

export async function obLogout(config: Config): Promise<ObResult> {
  return runOb(config, ["logout"]);
}

export async function obListRemoteVaults(config: Config): Promise<ObResult> {
  return runOb(config, ["sync-list-remote"]);
}

export async function obSyncSetup(
  config: Config,
  vault: string,
  password?: string,
  deviceName = "obsidian-mcp",
): Promise<ObResult> {
  const args = ["sync-setup", "--vault", vault, "--path", config.vaultDir, "--device-name", deviceName];
  if (password) args.push("--password", password);
  return runOb(config, args);
}

export async function obSyncStatus(config: Config): Promise<ObResult> {
  return runOb(config, ["sync-status", "--path", config.vaultDir], { timeoutMs: 30_000 });
}

export async function obSyncUnlink(config: Config): Promise<ObResult> {
  return runOb(config, ["sync-unlink", "--path", config.vaultDir]);
}
