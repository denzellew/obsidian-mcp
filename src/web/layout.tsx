import type { Child } from "hono/jsx";

export function Layout(props: { title?: string; children: Child; nav?: boolean; activeNav?: string }) {
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
      <body class="min-h-full">
        {props.nav !== false ? <Nav active={props.activeNav} /> : null}
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

function Nav(props: { active?: string }) {
  return (
    <nav class="border-b border-base-700 bg-base-900">
      <div class="mx-auto flex max-w-6xl items-center gap-1 px-6">
        <a href="/app" class="mr-4 flex shrink-0 items-center gap-2 py-3 font-semibold whitespace-nowrap text-text">
          <img src="/assets/logo.svg" alt="" class="h-5 w-5" />
          Obsidian MCP
        </a>
        {NAV_ITEMS.map(([href, label]) => (
          <a
            href={href}
            class={`shrink-0 rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${
              props.active === href ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {label}
          </a>
        ))}
        <form method="post" action="/logout" class="ml-auto shrink-0">
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
