import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AuthEnv } from "../auth/middleware.ts";
import type { VaultRegistry } from "../vaults/registry.ts";
import { Layout, Card } from "./layout.tsx";

export const VAULT_COOKIE = "obmcp_vault";
/** Hidden form field / htmx header carrying the vault a page was rendered for. */
export const VAULT_FIELD = "_vault";
export const VAULT_HEADER = "X-Vault";

// These act on the server as a whole, not on the selected vault.
const GLOBAL_PATHS = ["/app/passkeys", "/app/vault", "/app/vaults"];

const SECTIONS = ["audit", "guidance", "tokens", "connections", "sync", "snapshots", "passkeys", "vaults"];

/** The switcher's last option, which opens vault management instead of selecting a vault. */
export const MANAGE_VAULTS = "";

/**
 * Pick the vault the management UI is showing from the switcher cookie,
 * falling back to the first vault; with none yet, vault pages send the owner
 * to add one. The cookie is shared by every tab, so each mutation must also
 * name the vault its page was rendered for; a tab left open across a switch is
 * refused rather than writing to the newly selected vault.
 */
export function selectVault(vaults: VaultRegistry): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const global = GLOBAL_PATHS.some((p) => c.req.path.startsWith(p));
    const vault = vaults.get(getCookie(c, VAULT_COOKIE) ?? "") ?? vaults.all()[0];
    if (!vault) {
      if (global) return next();
      if (c.req.header("HX-Request")) {
        c.header("HX-Redirect", "/app/vaults");
        return c.body(null);
      }
      return c.redirect("/app/vaults");
    }
    c.set("vault", vault);
    if (c.req.method === "GET" || c.req.method === "HEAD" || global) return next();
    const presented = c.req.header(VAULT_HEADER) ?? (await formField(c, VAULT_FIELD));
    if (presented === vault.slug) return next();

    const shown = presented ? (vaults.get(presented)?.name ?? presented) : "another vault";
    if (c.req.header("HX-Request")) {
      // htmx won't swap a 409; reload so the tab shows the vault that is now selected
      c.header("HX-Refresh", "true");
      return c.text(`This tab was showing ${shown}; switched to ${vault.name}. Nothing was changed.`, 409);
    }
    return c.html(<StaleTabPage shown={shown} current={vault.name} back={sectionPath(c.req.header("referer"))} />, 409);
  };
}

async function formField(c: Context, name: string): Promise<string | undefined> {
  const type = c.req.header("content-type") ?? "";
  if (!type.includes("form")) return undefined;
  // parseBody caches, so the route handler can still read the body
  const value = (await c.req.parseBody())[name];
  return typeof value === "string" ? value : undefined;
}

/** The section root of a /app URL, so switching from a vault-specific page (a snapshot) lands somewhere valid. */
function sectionPath(url: string | undefined): string {
  try {
    const section = new URL(url ?? "").pathname.split("/")[2] ?? "";
    return SECTIONS.includes(section) ? `/app/${section}` : "/app";
  } catch {
    return "/app";
  }
}

function StaleTabPage(props: { shown: string; current: string; back: string }) {
  return (
    <Layout title="Vault changed">
      <Card title="Vault changed in another tab">
        <p class="text-sm text-text-muted">
          This page was showing <span class="font-semibold text-text">{props.shown}</span>, but{" "}
          <span class="font-semibold text-text">{props.current}</span> is now selected. Nothing was changed.
        </p>
        <a href={props.back} class="mt-3 inline-block text-sm text-accent-hover hover:underline">
          Continue in {props.current} →
        </a>
      </Card>
    </Layout>
  );
}

export function setVaultCookie(c: Context<AuthEnv>, slug: string): void {
  setCookie(c, VAULT_COOKIE, slug, {
    path: "/app",
    httpOnly: true,
    sameSite: "Lax",
    secure: c.var.secureCookies,
    maxAge: 365 * 24 * 3600,
  });
}

export function vaultSwitchRouter(vaults: VaultRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const picked = String(body.vault ?? "");
    let dest = "/app/vaults";
    if (picked !== MANAGE_VAULTS) {
      const target = vaults.get(picked);
      if (!target) return c.text("Unknown vault", 400);
      setVaultCookie(c, target.slug);
      dest = sectionPath(c.req.header("HX-Current-URL") ?? c.req.header("referer"));
    }
    if (c.req.header("HX-Request")) {
      c.header("HX-Redirect", dest);
      return c.body(null);
    }
    return c.redirect(dest);
  });

  return app;
}
