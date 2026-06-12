# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What this is

A self-hosted single-container service exposing an Obsidian vault over MCP, with a passkey-protected management UI, OAuth 2.1 + bearer auth, optional Obsidian Sync, and automatic git snapshots. Runtime is **Bun + TypeScript + Hono**; UI is **server-rendered Hono JSX + HTMX + Tailwind v4**; state is **bun:sqlite**.

## Commands

Use mise tasks (they pin the toolchain):

| Task | What |
|---|---|
| `mise run dev` | Server with hot reload + Tailwind watch → http://localhost:3000 |
| `mise run test` | Full `bun test` suite |
| `mise run typecheck` | `tsc --noEmit` |
| `mise run build` | Minify CSS + bundle server to `dist/` |
| `mise run docker:build` | Build the container image |

Direct equivalents: `bun test`, `bun test test/vault.test.ts` (single file), `bun test -t "name"` (by test name), `bunx tsc --noEmit`.

**Always run `bunx tsc --noEmit` and `bun test` before committing.** The suite is ~133 tests and ~25s; keep it green.

## Architecture (`src/`)

- `server.ts` — boot: config → migrate DB → snapshotter → sync supervisor → `Bun.serve`; SIGTERM lifecycle. `app.tsx` — Hono wiring, middleware order, route mounting.
- `config.ts` — env parsing. `PUBLIC_URL` is optional; when unset the public origin/rpID are derived per-request from proxy headers (`web/origin.ts`).
- `vault/` — the filesystem core. `paths.ts` (the `safePath`/`safeWritePath` chokepoint — all paths go through it), `store.ts` (atomic writes, per-path mutex, content-hash optimistic concurrency), `frontmatter.ts`, `markdown.ts`, `links.ts` (wikilink resolution + rewrite), `search.ts`, `obsidian-config.ts` (reads `.obsidian/` settings + moment-format dates).
- `mcp/` — `server.ts` builds the McpServer; one file per tool in `tools/`; `audit.ts` records every call; `context.ts` is the per-process handle passed to tools.
- `auth/` — `webauthn.ts` (passkeys, rpID pinning), `sessions.ts`, `tokens.ts` (static + OAuth bearer, hashed), `middleware.ts` (guards, rate limit, origin resolution).
- `oauth/` — hand-rolled OAuth 2.1 AS (DCR, PKCE, refresh rotation).
- `snapshots/` — git snapshots in a **bare repo outside the vault** (`--git-dir`/`--work-tree`), so no `.git` ever lands in `data/Vault`.
- `sync/` — `ob.ts` (isolates the obsidian-headless CLI; it's 0.0.x beta, flags may drift — change them only here), `supervisor.ts` (process supervision, SIGTERM→SIGKILL), `lock.ts` (one ob per vault).
- `web/` — `layout.tsx`, `routes/*.tsx` (one router per page), `origin.ts`.
- `db/` — `index.ts` (open + numbered migrations) and `migrations/*.sql`.

## Conventions

**Code style:** match the surrounding file. Comments explain *constraints the code can't show* (a race, a spec requirement, a workaround) — not what the next line does. Keep error messages actionable; MCP tool errors are written to *teach the model the correct next call* (see `mcp/respond.ts`).

**Imports:** ESM with explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions`). JSX uses `hono/jsx` (`jsxImportSource` in tsconfig) — files with JSX must be `.tsx`.

**UI:** Hono JSX SSR + HTMX (vendored in `public/vendor/`, no CDN). Dark, Obsidian-themed; accent `#7c3aed`; palette + tokens in `styles/app.css` `@theme`. **If you add or change Tailwind classes, rebuild the CSS** (`bunx @tailwindcss/cli -i styles/app.css -o public/app.css`) — `public/app.css` is a gitignored build artifact, and the dev task watches it but tests/prod use the built file. HTMX endpoints return HTML fragments; full pages wrap in `Layout`.

**Database:** `bun:sqlite`, WAL. Schema changes are **new numbered migration files** in `src/db/migrations/` (e.g. `0003_*.sql`) — never edit an applied migration. Migrations run on boot. Simple key/value config goes in the `settings` table via `getSetting`/`setSetting` (no migration needed).

**Tests:** `bun:test`. Use `test/helpers.ts` `tmpVault()` / `fixtureVault()` for throwaway vaults. Unit-test vault/markdown/links logic directly; integration tests boot the real app on `port: 0` and drive it with the MCP SDK client (`test/mcp.integration.test.ts`) or `fetch` (`test/auth.test.ts`, `test/origin.test.ts`). Tests that exercise timing (snapshots, supervisor) poll for a condition rather than sleeping a fixed time.

**Adding an MCP tool:** create `src/mcp/tools/<name>.ts` exporting `register<Name>(server, ctx)`, wrap the handler in `guarded()`, set `annotations` (`readOnlyHint`/`destructiveHint`), write the description like onboarding docs (state the "ALWAYS read before edit" style hints), register it in `mcp/server.ts`, and add it to the integration test's expected tool list. Mutations must go through `ctx.store` (hash-guarded) and call `ctx.snapshotter.noteMutation(...)`.

**Auth/origin:** never read the hostname from the raw `Host` header for security decisions — use the resolved `c.var.publicOrigin` / `c.var.rpId` (set by `resolveOriginMiddleware`). Tokens are stored as SHA-256 hashes and shown once.

## Versions & upgrades

Toolchain is exact-pinned in `.mise.toml` (Bun, Node LTS); deps are pinned by the committed `bun.lock` (`--frozen-lockfile` in CI + Docker); Docker base images and CI `bun-version` are pinned to exact patches. **Hold list:** `@modelcontextprotocol/sdk` stays on `1.x` (v2 is pre-alpha) and `zod` stays on `3.25.x` (MCP SDK peer compat). To bump anything, use the **`/upgrade`** skill (`.claude/skills/upgrade/`) — it encodes soaking discipline and where each version is pinned.

## Gotchas

- Env vars (esp. `PUBLIC_URL`) are read at boot; `bun --watch` reloads code but **not** env — restart `mise run dev` to change them.
- The vault can change underneath the server (Obsidian Sync). Reads return a `hash`; mutations verify it. Don't bypass `vault/store.ts`.
- Deletes are soft (`.trash/`); every mutation is git-snapshotted. Both recoverable, but say what changed.
