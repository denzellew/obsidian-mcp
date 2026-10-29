import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { getSetting, openDatabase } from "./db/index.ts";
import { createApp } from "./app.tsx";
import { passkeyCount } from "./auth/webauthn.ts";
import { sweepExpired } from "./auth/sessions.ts";
import { pruneAudit } from "./audit.ts";
import { VaultRegistry } from "./vaults/registry.ts";
import type { SetupState } from "./web/routes/setup.tsx";
import { logger } from "./log.ts";

const log = logger("server");

const config = loadConfig();

for (const dir of [config.dataDir, join(config.dataDir, "db")]) {
  mkdirSync(dir, { recursive: true });
}

const db = openDatabase(config.dbPath);

// --- auth bootstrap ---------------------------------------------------------

if (config.authReset) {
  db.exec("DELETE FROM passkey_credentials; DELETE FROM ui_sessions;");
  log.warn("AUTH_RESET=1: all passkeys and sessions wiped — setup mode re-entered. Unset AUTH_RESET and restart after re-registering.");
}

// In fixed mode, warn loudly if the configured host no longer matches the
// host passkeys were registered under. In derived mode this is enforced
// per-request with a user-facing message instead.
const rpAtSetup = getSetting(db, "rp_id_at_setup");
if (!config.derived && rpAtSetup && rpAtSetup !== config.rpId && passkeyCount(db) > 0) {
  log.warn(
    `PUBLIC_URL hostname changed (passkeys were registered for '${rpAtSetup}', now '${config.rpId}'). ` +
      `Existing passkeys will NOT work. Restart with AUTH_RESET=1 to re-run setup. Static API tokens still work.`,
  );
}

const setupState: SetupState = { token: null, pendingUserHandle: null };
if (passkeyCount(db) === 0) {
  setupState.token = `setup_${randomBytes(16).toString("hex")}`;
  const where = config.publicUrl ? `${config.publicUrl.origin}/setup` : "https://<your-host>/setup";
  // printed prominently; proves log access = box ownership
  console.log("\n" + "=".repeat(72));
  console.log("  FIRST-RUN SETUP");
  console.log(`  Open ${where} and enter this token:`);
  console.log(`\n      ${setupState.token}\n`);
  console.log("  A new token is generated on every restart until setup completes.");
  console.log("=".repeat(72) + "\n");
}

setInterval(() => {
  sweepExpired(db);
  pruneAudit(db);
}, 3_600_000);
sweepExpired(db);

// --- vaults (snapshots, sync) ---------------------------------------------------

const vaults = await VaultRegistry.boot(config, db);

// --- HTTP ---------------------------------------------------------------------

const app = createApp({ config, db, vaults, setupState });

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 120, // SSE streams
});

log.info(
  `listening on http://localhost:${server.port} (public: ${config.publicUrl?.origin ?? "derived from proxy headers"})`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  await server.stop();
  await vaults.shutdown(); // ob: SIGTERM → grace → SIGKILL, then final snapshot commits
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
