import type { Child } from "hono/jsx";
import { getContext } from "hono/context-storage";
import type { AppEnv } from "../app.tsx";
import type { VaultInstance } from "../vaults/registry.ts";

/** The vault the management UI is showing, when rendering inside an /app request. */
function selectedVault(): { current: VaultInstance; all: VaultInstance[] } | null {
  try {
    const c = getContext<AppEnv>();
    const current = c.var.vault;
    return current ? { current, all: c.var.deps.vaults.all() } : null;
  } catch {
    return null; // rendered outside a request (tests, error pages)
  }
}

/** Put in every plain (non-htmx) form that changes the selected vault; htmx requests send the header instead. */
export function VaultField() {
  const v = selectedVault();
  return v ? <input type="hidden" name="_vault" value={v.current.slug} /> : null;
}

export function Layout(props: { title?: string; children: Child; nav?: boolean; activeNav?: string }) {
  const vault = props.nav !== false ? selectedVault() : null;
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ? `${props.title} · Obsidian MCP` : "Obsidian MCP"}</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <link rel="icon" href="/assets/logo.svg" type="image/svg+xml" />
        <script src="/assets/vendor/htmx.min.js" defer></script>
      </head>
      <body class="min-h-full" hx-headers={vault ? JSON.stringify({ "X-Vault": vault.current.slug }) : undefined}>
        {props.nav !== false ? <Nav active={props.activeNav} vault={vault} /> : null}
        <main class={props.nav !== false ? "mx-auto max-w-6xl px-6 py-8" : ""}>{props.children}</main>
      </body>
    </html>
  );
}

const NAV_ITEMS = [
  ["/app", "Dashboard"],
  ["/app/audit", "Activity"],
  ["/app/guidance", "Guidance"],
  ["/app/tokens", "Tokens"],
  ["/app/connections", "Connections"],
  ["/app/sync", "Sync"],
  ["/app/snapshots", "Snapshots"],
  ["/app/passkeys", "Passkeys"],
] as const;

function Nav(props: { active?: string; vault: ReturnType<typeof selectedVault> }) {
  return (
    <nav class="border-b border-base-700 bg-base-900">
      <div class="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-6">
        <a href="/app" class="mr-2 flex shrink-0 items-center gap-2 py-3 font-semibold whitespace-nowrap text-text">
          <img src="/assets/logo.svg" alt="" class="h-5 w-5" />
          Obsidian MCP
        </a>
        {NAV_ITEMS.map(([href, label]) => (
          <a
            href={href}
            class={`shrink-0 rounded-md px-2 py-1.5 text-sm whitespace-nowrap ${
              props.active === href ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {label}
          </a>
        ))}
        {props.vault ? (
          <select
            name="vault"
            hx-post="/app/vault"
            hx-trigger="change"
            aria-label="Vault"
            class="ml-auto max-w-36 shrink-0 truncate rounded-md border border-base-600 bg-base-800 px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
          >
            {props.vault.all.map((v) => (
              <option value={v.slug} selected={v.id === props.vault!.current.id}>
                {v.name}
              </option>
            ))}
            <option value="">Manage vaults…</option>
          </select>
        ) : null}
        <form method="post" action="/logout" class={props.vault ? "shrink-0" : "ml-auto shrink-0"}>
          <button type="submit" class="px-2 py-1.5 text-sm whitespace-nowrap text-text-muted hover:text-text">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}

export function Card(props: { title?: string; children: Child }) {
  return (
    <section class="rounded-lg border border-base-700 bg-base-900 p-5">
      {props.title ? <h2 class="mb-3 text-base font-semibold">{props.title}</h2> : null}
      {props.children}
    </section>
  );
}
