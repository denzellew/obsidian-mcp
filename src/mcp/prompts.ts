import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "./context.ts";

export function registerPrompts(server: McpServer, ctx: VaultContext) {
  server.registerPrompt(
    "daily_review",
    {
      title: "Daily review",
      description: "Review yesterday and today's daily notes and plan the day.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Run my daily review:\n" +
              "1. Read today's and yesterday's daily notes (daily_note tool, action:'read').\n" +
              "2. Find open tasks ('- [ ]') in both, plus any notes modified yesterday (search_vault modified_after).\n" +
              "3. Summarize what happened yesterday and propose a short, prioritized plan for today.\n" +
              "4. Offer to append the plan to today's daily note under a 'Plan' heading.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "inbox_note",
    {
      title: "Capture to inbox",
      description: "Capture a thought into a well-formed note.",
      argsSchema: { thought: z.string().describe("The raw thought, link, or snippet to capture") },
    },
    ({ thought }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Capture this into my vault (vault name: ${ctx.vaultName}):\n\n"${thought}"\n\n` +
              "1. Check vault_info for structure, then search_vault for an existing related note.\n" +
              "2. If a clearly related note exists, append there under a sensible heading; otherwise create a new note in the most appropriate folder with good frontmatter (tags, date).\n" +
              "3. Keep my wording; add a one-line summary at the top if the capture is long. Tell me where it landed.",
          },
        },
      ],
    }),
  );
}
