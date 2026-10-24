import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VaultContext } from "../mcp/context.ts";
import type { McpServerOptions } from "../mcp/server.ts";
import { guarded, fail, ok } from "../mcp/respond.ts";
import { buildNote, parseNote } from "../vault/frontmatter.ts";
import { safeWritePath, withMdExtension } from "../vault/paths.ts";
import { allows, policyFor, type Sensitivity } from "./policy.ts";

const INSTRUCTIONS = `Personal Context MCP. This endpoint exposes only the smallest permitted personal context.
- Treat inferences as tentative and clearly labelled; never present them as established facts.
- Do not ask for or store passwords, API tokens, banking credentials, or identity-document numbers.
- Canonical records are read-only to clients. Use propose_personal_update for corrections; only the owner may approve a proposal.`;

function metadata(text: string) {
  const fm = parseNote(text).frontmatter ?? {};
  const category = typeof fm.category === "string" ? fm.category : null;
  const sensitivity = typeof fm.sensitivity === "string" ? fm.sensitivity : null;
  const confidence = typeof fm.confidence === "string" ? fm.confidence : null;
  const updated = typeof fm.updated === "string" ? fm.updated : null;
  const status = typeof fm.status === "string" ? fm.status : null;
  return {
    category,
    sensitivity,
    confidence,
    updated,
    status,
    summary: typeof fm.summary === "string" ? fm.summary : null,
    valid: category !== null && ["general", "private", "restricted"].includes(sensitivity ?? "") && confidence !== null && updated !== null && status !== null,
  };
}

function readable(text: string, policy: ReturnType<typeof policyFor>) {
  const meta = metadata(text);
  return meta.valid && meta.status === "active" && allows(policy, "read", meta.sensitivity!, meta.category!);
}

function proposalPath(): string {
  return `System/Review Queue/${new Date().toISOString().slice(0, 10)}-${randomUUID()}.md`;
}

export function createPersonalContextMcpServer(ctx: VaultContext, opts: McpServerOptions = {}): McpServer {
  if (!opts.db || !opts.principal) throw new Error("Personal Context MCP requires an authenticated principal and database.");
  const policy = policyFor(opts.db, opts.principal);
  const server = new McpServer({ name: "personal-context-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const audit = <A extends Record<string, unknown>>(name: string, handler: (args: A) => Promise<ReturnType<typeof ok>>) =>
    guarded(async (args: A) => {
      const result = await handler(args);
      opts.onToolCall?.(name, args, result);
      return result;
    });

  server.registerTool(
    "get_personal_profile",
    {
      title: "Get personal profile",
      description: "Return the concise approved Profile.md only when the caller is allowed its sensitivity and category.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    audit("get_personal_profile", async () => {
      if (!ctx.store.exists("Profile.md")) return fail("NOT_FOUND", "Profile.md is not present in this Personal Context vault.") as ReturnType<typeof ok>;
      const file = await ctx.store.readText("Profile.md");
      if (!readable(file.text, policy)) return fail("FORBIDDEN", "Your policy does not allow access to the personal profile.") as ReturnType<typeof ok>;
      return ok({ path: "Profile.md", ...metadata(file.text), body: parseNote(file.text).body, hash: file.hash });
    }),
  );

  server.registerTool(
    "search_personal_context",
    {
      title: "Search personal context",
      description: "Search only notes permitted by the caller's sensitivity and category policy. Results contain concise metadata and summaries, not complete note bodies.",
      inputSchema: { query: z.string().min(1), category: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    audit("search_personal_context", async ({ query, category }) => {
      const needle = query.toLowerCase();
      const results = [];
      for (const { path } of ctx.store.walkFiles()) {
        if (!path.endsWith(".md")) continue;
        const file = await ctx.store.readText(path);
        const meta = metadata(file.text);
        if (!readable(file.text, policy) || (category && meta.category !== category)) continue;
        const haystack = `${path}\n${file.text}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        results.push({ path, title: basename(path, ".md"), ...meta, hash: file.hash });
      }
      return ok({ results: results.slice(0, 20), policy: { sensitivities: policy.sensitivities, categories: policy.categories } });
    }),
  );

  server.registerTool(
    "get_personal_context",
    {
      title: "Get personal context",
      description: "Retrieve permitted active notes for one category. Use search_personal_context first when you do not know the category.",
      inputSchema: { category: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    audit("get_personal_context", async ({ category }) => {
      if (!allows(policy, "read", undefined, category)) return fail("FORBIDDEN", `Your policy does not permit the '${category}' category.`) as ReturnType<typeof ok>;
      const notes = [];
      for (const { path } of ctx.store.walkFiles()) {
        if (!path.endsWith(".md")) continue;
        const file = await ctx.store.readText(path);
        const meta = metadata(file.text);
        if (meta.category !== category || !meta.valid || meta.status !== "active") continue;
        if (!allows(policy, "read", meta.sensitivity!, category)) {
          return fail("FORBIDDEN", `Your policy does not permit the '${category}' context sensitivity.`) as ReturnType<typeof ok>;
        }
        if (readable(file.text, policy)) {
          notes.push({ path, ...meta, body: parseNote(file.text).body, hash: file.hash });
        }
      }
      return ok({ category, notes });
    }),
  );

  server.registerTool(
    "propose_personal_update",
    {
      title: "Propose personal update",
      description: "Create a review-only proposal. This does not change any canonical personal record. Include evidence and scope; use the current target hash when proposing a replacement.",
      inputSchema: {
        target_path: z.string().optional(),
        expected_hash: z.string().optional(),
        category: z.string().min(1),
        sensitivity: z.enum(["general", "private", "restricted"]).default("general"),
        content: z.string().min(1),
        evidence: z.string().min(1),
        scope: z.string().min(1),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    audit("propose_personal_update", async (args) => {
      if (!allows(policy, "propose", args.sensitivity, args.category)) return fail("FORBIDDEN", "Your policy does not permit this proposed update.") as ReturnType<typeof ok>;
      const path = proposalPath();
      const frontmatter = {
        type: "personal-context-proposal",
        status: "pending",
        target_path: args.target_path ? withMdExtension(safeWritePath(args.target_path)) : null,
        expected_hash: args.expected_hash ?? null,
        category: args.category,
        sensitivity: args.sensitivity,
        proposed_content: args.content,
        evidence: args.evidence,
        scope: args.scope,
        proposed_by: `${opts.principal!.kind}:${opts.principal!.id}`,
        created: ctx.now().toISOString(),
      };
      await ctx.store.write(path, buildNote(frontmatter, "# Proposed Personal Context Update\n\nPending owner review.\n"), { mustNotExist: true });
      ctx.snapshotter.noteMutation(`personal-context: propose update ${path}`);
      return ok({ proposal_id: path, status: "pending" });
    }),
  );

  server.registerTool(
    "approve_personal_update",
    {
      title: "Approve personal update",
      description: "Owner-only: promote a reviewed proposal to its existing canonical target using the hash captured at proposal time.",
      inputSchema: { proposal_id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    audit("approve_personal_update", async ({ proposal_id }) => {
      if (!allows(policy, "approve")) return fail("FORBIDDEN", "Only an owner policy may approve personal-context proposals.") as ReturnType<typeof ok>;
      const proposal = await ctx.store.readText(proposal_id);
      const fm = parseNote(proposal.text).frontmatter ?? {};
      if (fm.type !== "personal-context-proposal" || fm.status !== "pending") {
        return fail("INVALID_PROPOSAL", "proposal_id must name a pending personal-context proposal.") as ReturnType<typeof ok>;
      }
      const target = typeof fm.target_path === "string" ? fm.target_path : null;
      const content = typeof fm.proposed_content === "string" ? fm.proposed_content : null;
      if (!target || !content) return fail("INVALID_PROPOSAL", "Proposal needs an existing target_path and proposed content.") as ReturnType<typeof ok>;
      const targetMeta = metadata(await ctx.store.readText(target).then((file) => file.text));
      if (!targetMeta.valid || !allows(policy, "approve", targetMeta.sensitivity as Sensitivity, targetMeta.category!)) {
        return fail("FORBIDDEN", "Your owner policy does not cover the target note's category or sensitivity.") as ReturnType<typeof ok>;
      }
      const result = await ctx.store.write(target, content, { expectedHash: typeof fm.expected_hash === "string" ? fm.expected_hash : undefined });
      const approved = buildNote({ ...fm, status: "approved", approved_by: `${opts.principal!.kind}:${opts.principal!.id}`, approved_at: ctx.now().toISOString() }, parseNote(proposal.text).body);
      await ctx.store.write(proposal_id, approved, { expectedHash: proposal.hash });
      ctx.snapshotter.noteMutation(`personal-context: approve update ${proposal_id}`);
      return ok({ proposal_id, status: "approved", target_path: target, hash: result.hash });
    }),
  );
  return server;
}
