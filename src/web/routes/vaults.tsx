import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { Config } from "../../config.ts";
import { recordAdmin } from "../../audit.ts";
import { mcpPath, VaultError, type VaultInstance, type VaultRegistry } from "../../vaults/registry.ts";
import { setVaultCookie } from "../vault-context.tsx";

const INPUT = "rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none";

function syncLabel(v: VaultInstance): { text: string; class: string } {
  if (v.settings.get("sync_configured") !== "1") return { text: "not set up", class: "text-text-muted" };
  const state = v.sync?.status().state ?? "stopped";
  return { text: state, class: state === "running" ? "text-success" : state === "error" ? "text-danger" : "text-text-muted" };
}

function VaultRows(props: { vaults: VaultInstance[]; origin: string }) {
  if (props.vaults.length === 0) return <p class="text-sm text-text-muted">No vaults yet. Add one above to start serving it over MCP.</p>;
  return (
    <div class="space-y-4">
      {props.vaults.map((v) => {
        const sync = syncLabel(v);
        return (
          <div class="rounded-md border border-base-700 p-4">
            <form hx-post={`/app/vaults/${v.slug}/name`} hx-target={`#vault-error-${v.slug}`} class="flex flex-wrap items-center gap-3">
              <input type="text" name="name" value={v.name} required maxlength={60} aria-label="Vault name" class={`${INPUT} w-56`} />
              <button type="submit" class="rounded-md border border-base-600 px-3 py-1.5 text-sm text-text-muted hover:text-text">
                Rename
              </button>
              <button
                type="button"
                hx-delete={`/app/vaults/${v.slug}`}
                hx-target={`#vault-error-${v.slug}`}
                hx-confirm={`Remove '${v.name}'? Its tokens and connections are revoked and sync stops. Notes and snapshots stay on disk at ${v.config.vaultDir}.`}
                class="ml-auto text-sm text-danger hover:underline"
              >
                Remove
              </button>
            </form>
            <div id={`vault-error-${v.slug}`}></div>
            <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-text-muted">Slug</dt>
              <dd class="font-mono">{v.slug}</dd>
              <dt class="text-text-muted">MCP endpoint</dt>
              <dd class="font-mono break-all">{`${props.origin}${mcpPath(v)}`}</dd>
              <dt class="text-text-muted">Sync</dt>
              <dd class={sync.class}>{sync.text}</dd>
              <dt class="text-text-muted">Folder</dt>
              <dd class="font-mono break-all text-text-muted">{v.config.vaultDir}</dd>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function VaultsPage(props: { vaults: VaultInstance[]; origin: string; dataDir: string }) {
  return (
    <Layout title="Vaults">
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">Vaults</h1>
        <Card title="Add vault">
          <form hx-post="/app/vaults" hx-target="#add-vault-error" class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-sm text-text-muted">
              Name
              <input type="text" name="name" required maxlength={60} placeholder="e.g. Personal Context" class={`${INPUT} w-56`} />
            </label>
            <label class="flex flex-col gap-1 text-sm text-text-muted">
              Slug
              <input
                type="text"
                name="slug"
                required
                maxlength={40}
                pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
                placeholder="e.g. personal"
                class={`${INPUT} w-40 font-mono`}
              />
            </label>
            <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
              Add vault
            </button>
          </form>
          <div id="add-vault-error"></div>
          <p class="mt-3 text-sm text-text-muted">
            The slug is permanent: it names the MCP endpoint (<span class="font-mono">/v/&lt;slug&gt;/mcp</span>) and the folder{" "}
            <span class="font-mono">{props.dataDir}/vaults/&lt;slug&gt;/Vault</span>. Each vault starts empty with its own
            tokens, connections, and snapshots. Next you'll set up its Obsidian Sync, which uses its own login. To bring in an
            existing vault without Sync, copy its files into that folder.
          </p>
        </Card>
        <Card title="All vaults">
          <VaultRows vaults={props.vaults} origin={props.origin} />
        </Card>
      </div>
    </Layout>
  );
}

function ErrorText(props: { message: string }) {
  return <p class="mt-2 text-sm text-danger">{props.message}</p>;
}

/** Adding, renaming, and removing vaults. Server-wide: not scoped to the vault in the switcher. */
export function vaultsRouter(db: Database, config: Config, vaults: VaultRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => c.html(<VaultsPage vaults={vaults.all()} origin={c.var.publicOrigin} dataDir={config.dataDir} />));

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    try {
      const vault = await vaults.create(config, db, { slug: String(body.slug ?? ""), name: String(body.name ?? "") });
      recordAdmin(db, "vault.create", { target: `${vault.name} (${vault.slug})` });
      // switch to it and go straight to its sync setup
      setVaultCookie(c, vault.slug);
      c.header("HX-Redirect", "/app/sync");
      return c.body(null);
    } catch (err) {
      if (err instanceof VaultError) return c.html(<ErrorText message={err.message} />);
      throw err;
    }
  });

  app.post("/:slug/name", async (c) => {
    const body = await c.req.parseBody();
    try {
      const vault = vaults.rename(db, c.req.param("slug"), String(body.name ?? ""));
      recordAdmin(db, "vault.rename", { target: `${vault.name} (${vault.slug})` });
      c.header("HX-Refresh", "true"); // the switcher shows the name too
      return c.body(null);
    } catch (err) {
      if (err instanceof VaultError) return c.html(<ErrorText message={err.message} />);
      throw err;
    }
  });

  app.delete("/:slug", async (c) => {
    try {
      const vault = await vaults.remove(db, c.req.param("slug"));
      recordAdmin(db, "vault.remove", { target: `${vault.name} (${vault.slug})`, detail: `files kept at ${vault.config.vaultDir}` });
      c.header("HX-Refresh", "true");
      return c.body(null);
    } catch (err) {
      if (err instanceof VaultError) return c.html(<ErrorText message={err.message} />);
      throw err;
    }
  });

  return app;
}
