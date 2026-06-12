import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { getSetting, openDatabase } from "./db/index.ts";
import { createApp } from "./app.tsx";
import { VaultStore } from "./vault/store.ts";
import { LinkIndex } from "./vault/links.ts";
import { Snapshotter } from "./snapshots/snapshotter.ts";
import { createVaultContext } from "./mcp/context.ts";
import { passkeyCount } from "./auth/webauthn.ts";
import { sweepExpired } from "./auth/sessions.ts";
import { SyncSupervisor } from "./sync/supervisor.ts";
import type { SetupState } from "./web/routes/setup.tsx";
import { logger } from "./log.ts";

const log = logger("server");

const config = loadConfig();

for (const dir of [config.dataDir, config.vaultDir, config.obConfigDir, config.snapshotsDir, join(config.dataDir, "db")]) {
  mkdirSync(dir, { recursive: true });
}

const db = openDatabase(config.dbPath);

// --- auth bootstrap ---------------------------------------------------------

if (config.authReset) {
  db.exec("DELETE FROM passkey_credentials; DELETE FROM ui_sessions;");
  log.warn("AUTH_RESET=1: all passkeys and sessions wiped — setup mode re-entered. Unset AUTH_RESET and restart after re-registering.");
}

const rpAtSetup = getSetting(db, "rp_id_at_setup");
if (rpAtSetup && rpAtSetup !== config.rpId && passkeyCount(db) > 0) {
  log.warn(
    `PUBLIC_URL hostname changed (passkeys were registered for '${rpAtSetup}', now '${config.rpId}'). ` +
      `Existing passkeys will NOT work. Restart with AUTH_RESET=1 to re-run setup. Static API tokens still work.`,
  );
}

const setupState: SetupState = { token: null, pendingUserHandle: null };
if (passkeyCount(db) === 0) {
  setupState.token = `setup_${randomBytes(16).toString("hex")}`;
  // printed prominently; proves log access = box ownership
  console.log("\n" + "=".repeat(72));
  console.log("  FIRST-RUN SETUP");
  console.log(`  Open ${config.publicUrl.origin}/setup and enter this token:`);
  console.log(`\n      ${setupState.token}\n`);
  console.log("  A new token is generated on every restart until setup completes.");
  console.log("=".repeat(72) + "\n");
}

setInterval(() => sweepExpired(db), 3_600_000);
sweepExpired(db);

// --- vault, snapshots, sync --------------------------------------------------

const store = new VaultStore(config.vaultDir);
const links = new LinkIndex(store);
const snapshotter = new Snapshotter(config.snapshotsDir, config.vaultDir, {
  debounceMs: config.snapshotDebounceMs,
  maxWaitMs: config.snapshotMaxWaitMs,
  intervalMs: config.snapshotIntervalMs,
});
await snapshotter.init();
snapshotter.startTimers();

const vaultCtx = createVaultContext({ store, links, snapshotter, vaultName: basename(config.vaultDir) });

const sync = new SyncSupervisor(config, db);
sync.autostart();

// --- HTTP ---------------------------------------------------------------------

const app = createApp({ config, db, vaultCtx, setupState, sync });

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 120, // SSE streams
});

log.info(`listening on http://localhost:${server.port} (public: ${config.publicUrl.origin})`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  await server.stop();
  await sync.shutdown(); // SIGTERM → grace → SIGKILL (ob ignores SIGTERM)
  await snapshotter.shutdown(); // final commit if dirty
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
