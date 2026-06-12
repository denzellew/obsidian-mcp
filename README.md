# obsidian-mcp

A self-hosted MCP server + management UI for your Obsidian vault. One container gives you:

- **An MCP server** ([Streamable HTTP](https://modelcontextprotocol.io)) with 10 carefully designed tools for reading, searching, editing, and organizing notes — built for Claude Desktop, claude.ai, and Claude Code.
- **A passkey-protected management UI** (passkeys only, no passwords) for tokens, OAuth connections, sync, and snapshot history.
- **OAuth 2.1 + Dynamic Client Registration** so Claude Desktop/claude.ai connect with just a URL, plus named bearer tokens for Claude Code and other clients.
- **Optional Obsidian Sync** via the official [obsidian-headless](https://help.obsidian.md/headless) client (`ob sync --continuous`), supervised by the server and configured entirely from the web UI — including end-to-end-encrypted vaults. Requires an Obsidian Sync subscription; skip it and bring your own sync (Syncthing, git, nothing).
- **Automatic git snapshots** of the vault (debounced after every MCP mutation, before destructive operations, hourly, and at shutdown) stored in a bare repo outside the vault. Browse and restore from the UI.

All state lives in a single bind-mounted `./data` directory:

```
data/
├── Vault/               your Obsidian vault
├── db/app.db            server state (passkeys, tokens, OAuth grants)
├── obsidian-headless/   ob CLI auth + sync state
└── snapshots/vault.git  bare git repo with vault history
```

## Quick start

The server must be reachable over HTTPS (passkeys and Claude connectors require it). The recommended setup is a tunnel — no ports exposed at home:

- [`deploy/docker-compose.gatecrash.yml`](deploy/docker-compose.gatecrash.yml) — self-hosted [Gatecrash](https://github.com/jclement/gatecrash) tunnel
- [`deploy/docker-compose.cloudflared.yml`](deploy/docker-compose.cloudflared.yml) — Cloudflare Tunnel

```sh
mkdir obsidian-mcp && cd obsidian-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/jclement/obsidian-mcp/main/deploy/docker-compose.gatecrash.yml
# create .env with PUBLIC_URL + tunnel credentials (see comments in the compose file)
docker compose up -d
docker compose logs app        # ← copy the FIRST-RUN SETUP token
```

Open `https://your-host/setup`, paste the token, and register a passkey. That passkey is now the only way into the management UI; add more from the Passkeys page.

### Connect Claude Desktop / claude.ai

Settings → Connectors → Add custom connector → `https://your-host/mcp`. Claude discovers the OAuth endpoints, registers itself, and sends you to your server to approve with your passkey. Done.

### Connect Claude Code

Create a token in the UI (Tokens → name it → copy once), then:

```sh
claude mcp add --transport http obsidian https://your-host/mcp \
  --header "Authorization: Bearer obmcp_..."
```

### Connect Obsidian Sync (optional)

UI → Sync → sign in with your Obsidian account (+2FA), pick a remote vault, optionally provide the end-to-end encryption password. The server runs `ob sync --continuous`, restarts it with backoff if it dies, and shows a live log. Credentials are passed straight to the `ob` CLI and never stored by this server.

## The MCP tools

| Tool | What it does |
|---|---|
| `vault_info` | Orientation: counts, daily-note config, templates, recent notes |
| `browse_vault` | Folder listing or compact tree |
| `search_vault` | Unified content + filename + tag search with highlighted snippets, filters, pagination |
| `read_note` | Frontmatter + body + content `hash`; outline/section modes for huge notes; batch reads; images render inline |
| `create_note` | New notes, structured frontmatter, template instantiation ({{date}}, {{time}}, {{title}}) |
| `edit_note` | Surgical edits: exact-match replace, append (under a heading), section replace, frontmatter set/remove — atomic, hash-guarded |
| `manage_note` | Move/copy/delete with automatic backlink rewriting; deletes go to `.trash/` |
| `get_links` | Backlinks (with context), outgoing links, embeds, unresolved links |
| `list_tags` | All tags (frontmatter + inline, nested) with counts |
| `daily_note` | Read/append today's (or any date's) daily note honoring the vault's own settings and template |

Design notes:

- **Safe concurrent editing.** The vault can change underneath the server (Obsidian Sync). Every read returns a content hash; edits verify it and fail with a retryable error if the note changed. Whole-content replacement *requires* the hash. Writes are atomic (temp file + rename) and serialized per note.
- **Obsidian-native behavior.** Wikilink resolution, daily-note paths, templates, and link rewriting all honor the vault's `.obsidian/` settings. The server never writes into `.obsidian/`.
- **Recoverable by design.** Deletes are soft (`.trash/`), every mutation is git-snapshotted, and destructive ops take a synchronous pre-snapshot.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | — (optional) | Pin the external URL. **Leave unset** to auto-derive it from your reverse proxy's `X-Forwarded-Proto`/`X-Forwarded-Host` per request (the common case behind a single tunnel). Set it only when you want to hard-pin the origin or run behind multiple/untrusted proxies. |
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `/data` | Root for all persistent state |
| `VAULT_DIR` | `$DATA_DIR/Vault` | Vault location |
| `SYNC_AUTOSTART` | `true` | Resume `ob sync` on boot if previously enabled |
| `OB_KILL_GRACE_MS` | `5000` | SIGTERM→SIGKILL grace for ob ([it ignores SIGTERM](https://github.com/obsidianmd/obsidian-headless/issues/25)) |
| `SNAPSHOT_DEBOUNCE_MS` | `30000` | Snapshot debounce after mutations |
| `SNAPSHOT_INTERVAL_MS` | `3600000` | Periodic dirty-check snapshot |
| `AUTH_RESET` | — | Set to `1` to wipe passkeys/sessions and re-enter setup (e.g. after a hostname change) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Security model

- Management UI: **passkeys only**, user verification required, discoverable credentials (one-tap). Sessions are DB-backed, HttpOnly, SameSite=Lax cookies.
- First-run trust: `/setup` requires a token printed to server logs (proof of box ownership); the page 404s once a passkey exists.
- Hostname handling: when `PUBLIC_URL` is unset the origin/rpID are derived from the proxy's forwarded headers, and the WebAuthn rpID is **pinned** at first-passkey setup — a later request arriving with a different host is rejected (use `AUTH_RESET=1` to re-key if the hostname legitimately changes). WebAuthn's crypto binds each credential to the browser-signed origin regardless, so a forged forwarded header cannot impersonate your host.
- MCP: OAuth 2.1 (PKCE S256 mandatory, RFC 8414/9728 metadata, RFC 7591 DCR, refresh rotation with reuse detection) **or** static bearer tokens. All tokens stored as SHA-256 hashes, shown once, revocable from the UI; revocation also kills live streams.
- Host-header guard (DNS rebinding), Origin checks on `/mcp`, CSRF protection on the UI, rate-limited auth endpoints.
- `data/db/app.db` contains only hashes and public keys — safe to back up.

## Development

Requires [mise](https://mise.jdx.dev) (pins bun + node) and git.

```sh
mise install
bun install
mise run dev          # server with hot reload + tailwind watch → http://localhost:3000
mise run test         # bun test (112 tests)
mise run typecheck
mise run docker:build
mise run ob:install   # optional: real obsidian-headless for local sync testing
```

Local dev uses the same `./data` layout as production and passkeys work on `http://localhost`.

## Recovery cheatsheet

```sh
# full vault history
git --git-dir data/snapshots/vault.git --work-tree data/Vault log --oneline

# restore everything to a snapshot
git --git-dir data/snapshots/vault.git --work-tree data/Vault checkout <sha> -- .

# lost your passkey?
AUTH_RESET=1 docker compose up -d   # re-enters setup mode; unset afterwards
```
