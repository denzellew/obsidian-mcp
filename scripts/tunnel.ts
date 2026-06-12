#!/usr/bin/env bun
/**
 * Dev-only tunnel runner. Starts whichever reverse tunnels are *configured*
 * (binary on PATH AND its env vars present) pointing at the local dev server —
 * gatecrash, cloudflared, both, or neither.
 *
 * Production does NOT use this: there you run the tunnel as a docker-compose
 * sidecar (see deploy/). This is purely so `mise run tunnel` exposes your local
 * `mise run dev` server while you work.
 *
 * Env is read from your shell and `.env` (Bun auto-loads it). See .env.example.
 */

const PORT = process.env.PORT ?? "3000";
const localTarget = `localhost:${PORT}`;

interface Provider {
  name: string;
  bin: string;
  /** env vars required to consider it configured */
  requires: string[];
  /** build argv (sans bin) and any extra env for the child */
  command: () => { args: string[]; env?: Record<string, string> };
  installHint: string;
}

const providers: Provider[] = [
  {
    name: "gatecrash",
    bin: process.env.GATECRASH_BIN ?? "gatecrash",
    requires: ["GATECRASH_SERVER", "GATECRASH_TOKEN"],
    command: () => ({
      args: [],
      env: {
        GATECRASH_SERVER: process.env.GATECRASH_SERVER!,
        GATECRASH_HOST_KEY: process.env.GATECRASH_HOST_KEY ?? "",
        GATECRASH_TOKEN: process.env.GATECRASH_TOKEN!,
        GATECRASH_TARGET: process.env.GATECRASH_TARGET ?? localTarget,
      },
    }),
    installHint: "https://github.com/jclement/gatecrash — install the client binary, or `brew install jclement/tap/gatecrash`",
  },
  {
    name: "cloudflared",
    bin: process.env.CLOUDFLARED_BIN ?? "cloudflared",
    requires: ["CLOUDFLARED_TUNNEL_TOKEN"],
    command: () => ({
      args: ["tunnel", "--no-autoupdate", "run", "--token", process.env.CLOUDFLARED_TUNNEL_TOKEN!],
    }),
    installHint: "https://developers.cloudflare.com/cloudflared — `brew install cloudflared`. Point the tunnel's public hostname at " + `http://${localTarget}`,
  },
];

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function has(bin: string): boolean {
  return Bun.which(bin) !== null;
}

function envPresent(p: Provider): boolean {
  return p.requires.every((k) => !!process.env[k]);
}

const toRun: Provider[] = [];

for (const p of providers) {
  const configured = envPresent(p);
  const installed = has(p.bin);
  if (configured && installed) {
    toRun.push(p);
  } else if (configured && !installed) {
    console.log(`${C.yellow("⚠")} ${C.bold(p.name)} is configured but '${p.bin}' is not on PATH — skipping.`);
    console.log(`  ${C.dim(p.installHint)}`);
  } else if (!configured && installed) {
    console.log(`${C.dim(`· ${p.name} installed but not configured (set ${p.requires.join(", ")}) — skipping`)}`);
  }
}

if (toRun.length === 0) {
  console.log(C.dim("\nNo tunnels configured. Set tunnel env vars in .env (see .env.example), then re-run."));
  console.log(C.dim(`Tunnels forward to http://${localTarget} — start the app with \`mise run dev\` in another terminal.`));
  process.exit(0);
}

console.log(C.bold(`\nStarting ${toRun.length} tunnel(s) → http://${localTarget}  (Ctrl-C to stop)\n`));

const children = toRun.map((p) => {
  const { args, env } = p.command();
  const proc = Bun.spawn([p.bin, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  void prefix(p.name, proc.stdout as ReadableStream);
  void prefix(p.name, proc.stderr as ReadableStream);
  console.log(`${C.green("▶")} ${p.name} (pid ${proc.pid})`);
  return { p, proc };
});

async function prefix(name: string, stream: ReadableStream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const tag = C.dim(`[${name}]`);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) console.log(`${tag} ${line}`);
    }
  } catch {}
  if (buf.trim()) console.log(`${tag} ${buf}`);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log(C.dim("\nstopping tunnels…"));
  for (const { proc } of children) {
    try {
      proc.kill();
    } catch {}
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// exit once every child has exited
const codes = await Promise.all(children.map(({ p, proc }) => proc.exited.then((code) => ({ p, code }))));
for (const { p, code } of codes) {
  if (code !== 0 && !stopping) console.log(`${C.red("✗")} ${p.name} exited with code ${code}`);
}
process.exit(stopping ? 0 : (codes.some((c) => c.code !== 0) ? 1 : 0));
