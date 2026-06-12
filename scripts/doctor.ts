#!/usr/bin/env bun
/**
 * Dev-only diagnostics: `mise run doctor`. Shows toolchain versions, runtime
 * config, the data dir layout, Obsidian Sync readiness, which dev tunnels are
 * configured, and whether the dev server is responding. Read-only; secrets are
 * shown as set/unset, never printed.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const OK = C.green("✓");
const NO = C.red("✗");
const SKIP = C.dim("·");
const WARN = C.yellow("⚠");

function header(s: string) {
  console.log(`\n${C.bold(C.cyan(s))}`);
}
function row(mark: string, label: string, detail = "") {
  console.log(`  ${mark} ${label.padEnd(22)} ${C.dim(detail)}`);
}

async function version(bin: string, args: string[]): Promise<string | null> {
  if (!Bun.which(bin)) return null;
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim() || (await new Response(proc.stderr).text()).trim();
    await proc.exited;
    return out.split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

const PORT = process.env.PORT ?? "3000";
const DATA_DIR = process.env.DATA_DIR ?? "./data";

console.log(C.bold("\nobsidian-mcp · dev doctor"));

// --- toolchain ---
header("Toolchain");
const bunV = await version("bun", ["--version"]);
row(bunV ? OK : NO, "bun", bunV ?? "not found");
const nodeBin = await version("node", ["--version"]);
row(nodeBin ? OK : WARN, "node (on PATH)", nodeBin ? `${nodeBin}  ${C.dim("(runs `ob`)")}` : "not found — needed for `ob`");
row(SKIP, "node (bun-compat)", process.version);
const gitV = await version("git", ["--version"]);
row(gitV ? OK : NO, "git", (gitV ?? "not found").replace("git version ", ""));
const miseV = await version("mise", ["--version"]);
row(miseV ? OK : SKIP, "mise", miseV ?? "not found");

// --- runtime config ---
header("Runtime config");
row(SKIP, "PORT", PORT);
row(SKIP, "DATA_DIR", DATA_DIR);
row(SKIP, "PUBLIC_URL", process.env.PUBLIC_URL ?? "(unset → derived from proxy headers)");
row(SKIP, "LOG_LEVEL", process.env.LOG_LEVEL ?? "info");

// --- dependencies ---
header("Project");
row(existsSync("node_modules") ? OK : NO, "node_modules", existsSync("node_modules") ? "installed" : "run `bun install`");
row(existsSync("public/app.css") ? OK : WARN, "public/app.css", existsSync("public/app.css") ? "built" : "run the css build (mise run dev / build)");

// --- data dir ---
header(`Data dir (${DATA_DIR})`);
function dirInfo(sub: string, label: string, extra?: () => string) {
  const p = join(DATA_DIR, sub);
  if (existsSync(p)) row(OK, label, extra ? extra() : "present");
  else row(SKIP, label, "not created yet");
}
dirInfo("Vault", "Vault/", () => {
  try {
    let n = 0;
    for (const _ of new Bun.Glob("**/*.md").scanSync({ cwd: join(DATA_DIR, "Vault"), dot: false })) {
      n++;
      if (n > 100000) break;
    }
    return `${n} notes`;
  } catch {
    return "present";
  }
});
dirInfo("db/app.db".replace("/app.db", ""), "db/", () => (existsSync(join(DATA_DIR, "db/app.db")) ? "app.db present" : "empty"));
dirInfo("snapshots/vault.git".replace("/vault.git", ""), "snapshots/", () =>
  existsSync(join(DATA_DIR, "snapshots/vault.git")) ? "vault.git present" : "no repo yet",
);
dirInfo("obsidian-headless", "obsidian-headless/");

// --- obsidian sync ---
header("Obsidian Sync (optional)");
const obBin = process.env.OB_BIN ?? "ob";
const obV = await version(obBin, ["--version"]);
row(obV ? OK : SKIP, `${obBin} (obsidian-headless)`, obV ?? "not installed — `mise run ob:install` for local sync testing");

// --- dev tunnels ---
header("Dev tunnels  (binary + env ⇒ `mise run tunnel` starts it)");
function tunnelStatus(name: string, bin: string, requires: string[]) {
  const installed = !!Bun.which(bin);
  const configured = requires.every((k) => !!process.env[k]);
  let mark = SKIP;
  let detail: string;
  if (installed && configured) {
    mark = OK;
    detail = "ready";
  } else if (configured && !installed) {
    mark = WARN;
    detail = `configured but '${bin}' not on PATH`;
  } else if (installed && !configured) {
    detail = `installed; set ${requires.join(", ")}`;
  } else {
    detail = `not installed; set ${requires.join(", ")}`;
  }
  row(mark, name, detail);
}
tunnelStatus("gatecrash", process.env.GATECRASH_BIN ?? "gatecrash", ["GATECRASH_SERVER", "GATECRASH_TOKEN"]);
tunnelStatus("cloudflared", process.env.CLOUDFLARED_BIN ?? "cloudflared", ["CLOUDFLARED_TUNNEL_TOKEN"]);

// --- dev server ---
header("Dev server");
try {
  const res = await fetch(`http://localhost:${PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
  row(res.ok ? OK : WARN, `localhost:${PORT}`, res.ok ? "responding (/healthz ok)" : `responded ${res.status}`);
} catch {
  row(SKIP, `localhost:${PORT}`, "not running — `mise run dev`");
}

console.log("");
