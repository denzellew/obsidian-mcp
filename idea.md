https://obsidian.md/help/headless
https://github.com/jclement/gatecrash

MCP Server for Obsidian
Simgle docker compose that brings up
- Gatecrash (attaching this thing to the Internet)
- MCP/Management UI (shares ./data/Vault)
- Obsidian Headless (shares ./data/Vault)

All data bind mounted to folders under ./data

Management UI uses Passkeys only for user login
Initial setup requires you to configure passkey.  Can add additional passkeys if required in management UI.
Single user, Single vault (for now).

Ideally, initial setup also handles initializing Obsidian headless via. webui (including encrypted vaults).

Management UI supports OAuth (compatible with Claude Desktop) or Bearer Token.  Tokes are named.
Management UI lets you manage keys (see last use time, delete, etc.)

Build a great set of tools for managing Obsidian Vault.
Lots of documentation.  Hints like "ALWAYS READ LATEST before mutations".  Etc.

Probably bun for the server
Tailwind
If you can combine Obsidian Headless and Management UI intp a single container, that'd be coolio.

mise for development tooling
mise run dev -- runs stack locally, ideally with hotreload
spend a bunch of time thinking about how to make the best god damned MCP tools for working with Obsidian

UI should be sexy and Obsidian themed.

Github jclement/obsidian-mcp
Github action to build containers

Sample docker-compose use Gatecrash and another for Cloudflare Funnels

