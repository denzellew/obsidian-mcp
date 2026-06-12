import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "./context.ts";
import { isMarkdown, isImage, safePath } from "../vault/paths.ts";

/**
 * Thin resource layer: lets clients @-mention vault files directly.
 * Everything here is also reachable via tools; clients that ignore
 * resources lose nothing.
 */
export function registerResources(server: McpServer, ctx: VaultContext) {
  server.registerResource(
    "vault-root",
    "vault:///",
    {
      title: "Vault overview",
      description: "Folder tree of the Obsidian vault (depth 2).",
      mimeType: "text/plain",
    },
    async () => {
      const lines: string[] = [];
      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 2) return;
        let entries;
        try {
          entries = ctx.store.list(dir);
        } catch {
          return;
        }
        for (const e of entries.slice(0, 50)) {
          lines.push(`${prefix}${e.type === "folder" ? `${e.name}/` : e.name}`);
          if (e.type === "folder") walk(e.path, `${prefix}  `, depth + 1);
        }
      };
      walk("", "", 1);
      return { contents: [{ uri: "vault:///", mimeType: "text/plain", text: lines.join("\n") }] };
    },
  );

  server.registerResource(
    "note",
    new ResourceTemplate("vault:///{+path}", {
      list: undefined,
      complete: {
        path: (value) => {
          const matches: string[] = [];
          const lower = value.toLowerCase();
          for (const f of ctx.store.walkFiles()) {
            if (f.path.toLowerCase().includes(lower)) {
              matches.push(f.path);
              if (matches.length >= 20) break;
            }
          }
          return matches;
        },
      },
    }),
    {
      title: "Vault note",
      description: "A note or attachment in the vault, by vault-relative path.",
    },
    async (uri, variables) => {
      const pathVar = variables.path;
      const rel = safePath(decodeURIComponent(Array.isArray(pathVar) ? pathVar.join("/") : String(pathVar ?? "")));
      if (isMarkdown(rel)) {
        const { text } = await ctx.store.readText(rel);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      }
      const raw = await ctx.store.readRaw(rel);
      const mime = isImage(rel) ? `image/${rel.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")}` : "application/octet-stream";
      return { contents: [{ uri: uri.href, mimeType: mime, blob: Buffer.from(raw.bytes).toString("base64") }] };
    },
  );
}
