import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { getSetting, setSetting, deleteSetting } from "../../db/index.ts";
import { recordAdmin } from "../../audit.ts";

const MAX_LEN = 8000;

const PLACEHOLDER = `e.g.
- Weekly notes live in Journal/Weekly and use the template Templates/Weekly.md (period: every Monday).
- I use the Tasks plugin: open tasks are "- [ ] ..." lines; done are "- [x] ...". Use search_vault with a regex to find them.
- Capture loose ideas into Inbox.md, not the daily note.
- Project notes go under Projects/ with frontmatter: status (active|paused|done) and a #project tag.`;

function GuidancePage(props: { value: string; saved?: boolean }) {
  return (
    <Layout title="Guidance" activeNav="/app/guidance">
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">Vault guidance</h1>
        <Card>
          <p class="mb-4 text-sm text-text-muted">
            Tell connected AI clients how <em>your</em> vault works — conventions, folder layout, plugins (Tasks,
            Periodic Notes), naming. This text is sent to the model as part of the MCP server's instructions and is also
            returned by the <span class="font-mono">vault_info</span> tool, so it travels with every session. Keep it
            tight; it competes for the model's attention with everything else.
          </p>
          <form hx-post="/app/guidance" hx-target="#guidance-status" hx-swap="innerHTML">
            <textarea
              name="guidance"
              rows={14}
              maxlength={MAX_LEN}
              placeholder={PLACEHOLDER}
              class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 font-mono text-sm leading-relaxed focus:border-accent focus:outline-none"
            >{props.value}</textarea>
            <div class="mt-3 flex items-center gap-3">
              <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
                Save
              </button>
              <span id="guidance-status" class="text-sm text-success">
                {props.saved ? "Saved." : ""}
              </span>
            </div>
          </form>
        </Card>
      </div>
    </Layout>
  );
}

export function guidanceRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => c.html(<GuidancePage value={getSetting(db, "vault_instructions") ?? ""} />));

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const value = String(body.guidance ?? "").trim().slice(0, MAX_LEN);
    if (value) setSetting(db, "vault_instructions", value);
    else deleteSetting(db, "vault_instructions");
    recordAdmin(db, "guidance.update", { detail: value ? `${value.length} chars` : "cleared" });
    return c.html(<span class="text-sm text-success">Saved — applies to new MCP sessions.</span>);
  });

  return app;
}
