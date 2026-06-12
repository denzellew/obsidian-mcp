import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { SyncSupervisor } from "../../sync/supervisor.ts";
import { getSetting, setSetting, deleteSetting } from "../../db/index.ts";
import { obInstalled, obListRemoteVaults, obLogin, obLogout, obSyncSetup, obSyncUnlink } from "../../sync/ob.ts";
import { recordAdmin } from "../../audit.ts";

function StateBadge(props: { state: string }) {
  const color =
    props.state === "running" ? "bg-success/20 text-success" :
    props.state === "error" ? "bg-danger/20 text-danger" :
    "bg-base-700 text-text-muted";
  return <span class={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{props.state}</span>;
}

function LogPanel(props: { lines: string[] }) {
  return (
    <pre
      id="sync-log"
      hx-get="/app/sync/log"
      hx-trigger="every 2s"
      hx-swap="outerHTML"
      class="h-64 overflow-y-auto rounded-md bg-base-950 p-3 font-mono text-xs text-text-muted"
    >
      {props.lines.length ? props.lines.join("\n") : "(no output yet)"}
    </pre>
  );
}

function Controls(props: { state: string; desired: boolean }) {
  return (
    <div id="sync-controls" class="flex items-center gap-3">
      <StateBadge state={props.state} />
      <form method="post" action="/app/sync/start">
        <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover" type="submit">
          Start
        </button>
      </form>
      <form method="post" action="/app/sync/stop">
        <button class="rounded-md border border-base-600 px-3 py-1.5 text-sm text-text-muted hover:text-text" type="submit">
          Stop
        </button>
      </form>
      <form method="post" action="/app/sync/restart">
        <button class="rounded-md border border-base-600 px-3 py-1.5 text-sm text-text-muted hover:text-text" type="submit">
          Restart
        </button>
      </form>
    </div>
  );
}

function WizardLogin(props: { error?: string; notice?: string }) {
  return (
    <div id="wizard">
      {props.error ? <p class="mb-3 text-sm text-danger">{props.error}</p> : null}
      {props.notice ? <p class="mb-3 text-sm text-success">{props.notice}</p> : null}
      <p class="mb-4 text-sm text-text-muted">
        Step 1 of 2 — sign in with your Obsidian account (requires an{" "}
        <a href="https://obsidian.md/sync" class="text-accent-hover hover:underline">Obsidian Sync</a> subscription).
        Credentials are passed to the <span class="font-mono">ob</span> CLI and never stored by this server.
      </p>
      <form hx-post="/app/sync/login" hx-target="#wizard" hx-swap="outerHTML" class="space-y-3">
        <input type="email" name="email" required placeholder="Email"
          class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <input type="password" name="password" required placeholder="Password"
          class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <input type="text" name="mfa" placeholder="2FA code (if enabled)" autocomplete="one-time-code"
          class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
          Sign in to Obsidian
        </button>
      </form>
    </div>
  );
}

function WizardPickVault(props: { vaultListing: string; error?: string }) {
  return (
    <div id="wizard">
      {props.error ? <p class="mb-3 text-sm text-danger">{props.error}</p> : null}
      <p class="mb-2 text-sm text-text-muted">Step 2 of 2 — connect a remote vault to this server's vault directory.</p>
      <p class="mb-2 text-xs text-text-muted">Your remote vaults (from <span class="font-mono">ob sync-list-remote</span>):</p>
      <pre class="mb-4 max-h-40 overflow-y-auto rounded-md bg-base-950 p-3 font-mono text-xs text-text-muted">{props.vaultListing}</pre>
      <form hx-post="/app/sync/setup" hx-target="#wizard" hx-swap="outerHTML" class="space-y-3">
        <input type="text" name="vault" required placeholder="Vault name or ID (exactly as listed)"
          class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <input type="password" name="password" placeholder="Encryption password (end-to-end encrypted vaults only)"
          class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <p class="text-xs text-warning">
          Heads-up: connecting downloads the remote vault into this server's vault directory and starts bidirectional
          sync. If this server's vault already has notes, they will sync up to the remote vault too.
        </p>
        <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
          Connect vault &amp; start sync
        </button>
      </form>
    </div>
  );
}

export function syncRouter(db: Database, config: Config, sync: SyncSupervisor): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const isConfigured = () => getSetting(db, "sync_configured") === "1";

  app.get("/", (c) => {
    const status = sync.status();
    const installed = obInstalled(config);
    return c.html(
      <Layout title="Sync" activeNav="/app/sync">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Obsidian Sync</h1>
          {!installed ? (
            <Card>
              <p class="text-sm text-warning">
                The <span class="font-mono">ob</span> CLI (obsidian-headless) is not installed or not on PATH — sync is
                unavailable. In Docker it ships with the image; locally run{" "}
                <span class="font-mono">mise run ob:install</span>.
              </p>
            </Card>
          ) : null}
          {isConfigured() ? (
            <>
              <Card title="Daemon">
                <Controls state={status.state} desired={status.desired} />
                {status.lastError ? <p class="mt-3 text-sm text-danger">{status.lastError}</p> : null}
              </Card>
              <Card title="Live log">
                <LogPanel lines={sync.recentLog()} />
              </Card>
              <Card title="Danger zone">
                <form method="post" action="/app/sync/unlink">
                  <button
                    type="submit"
                    class="rounded-md border border-danger/50 px-4 py-2 text-sm text-danger hover:bg-danger/10"
                  >
                    Disconnect Obsidian Sync
                  </button>
                </form>
                <p class="mt-2 text-xs text-text-muted">Stops the daemon and unlinks the vault. Local files stay intact.</p>
              </Card>
            </>
          ) : (
            <Card title="Set up Obsidian Sync (optional)">
              <WizardLogin />
            </Card>
          )}
        </div>
      </Layout>,
    );
  });

  app.get("/log", (c) => c.html(<LogPanel lines={sync.recentLog()} />));

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const mfa = String(body.mfa ?? "").trim() || undefined;
    if (!email || !password) return c.html(<WizardLogin error="Email and password are required." />);
    const result = await obLogin(config, email, password, mfa);
    if (!result.ok) {
      recordAdmin(db, "sync.login", { status: "error", target: email });
      return c.html(<WizardLogin error={`Login failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`} />);
    }
    recordAdmin(db, "sync.login", { target: email });
    const listing = await obListRemoteVaults(config);
    if (!listing.ok) {
      return c.html(<WizardLogin error={`Signed in, but listing vaults failed: ${(listing.stderr || listing.stdout).trim().slice(0, 500)}`} />);
    }
    return c.html(<WizardPickVault vaultListing={listing.stdout.trim() || "(no vaults found)"} />);
  });

  app.post("/setup", async (c) => {
    const body = await c.req.parseBody();
    const vault = String(body.vault ?? "").trim();
    const password = String(body.password ?? "") || undefined;
    if (!vault) {
      const listing = await obListRemoteVaults(config);
      return c.html(<WizardPickVault vaultListing={listing.stdout.trim()} error="Vault name is required." />);
    }
    const result = await obSyncSetup(config, vault, password);
    if (!result.ok) {
      const listing = await obListRemoteVaults(config);
      return c.html(
        <WizardPickVault
          vaultListing={listing.stdout.trim()}
          error={`sync-setup failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`}
        />,
      );
    }
    setSetting(db, "sync_configured", "1");
    recordAdmin(db, "sync.configure", { target: vault });
    sync.start();
    c.header("HX-Redirect", "/app/sync");
    return c.html(<p>Connected.</p>);
  });

  app.post("/start", (c) => {
    sync.start();
    recordAdmin(db, "sync.start");
    return c.redirect("/app/sync");
  });

  app.post("/stop", async (c) => {
    await sync.stop();
    recordAdmin(db, "sync.stop");
    return c.redirect("/app/sync");
  });

  app.post("/restart", async (c) => {
    await sync.restart();
    recordAdmin(db, "sync.restart");
    return c.redirect("/app/sync");
  });

  app.post("/unlink", async (c) => {
    await sync.stop();
    await obSyncUnlink(config);
    await obLogout(config);
    deleteSetting(db, "sync_configured");
    recordAdmin(db, "sync.unlink");
    return c.redirect("/app/sync");
  });

  return app;
}
