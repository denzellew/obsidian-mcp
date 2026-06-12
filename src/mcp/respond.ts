import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { VaultPathError } from "../vault/paths.ts";
import { VaultError } from "../vault/store.ts";
import { SearchError } from "../vault/search.ts";

/** Successful tool result: JSON payload rendered as text. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
}

/** Error result with a teaching message the model can act on. */
export function fail(code: string, message: string): CallToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

/**
 * Wrap a tool handler so domain errors become actionable isError results
 * instead of protocol-level failures.
 */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof VaultError) return fail(err.code, err.message);
      if (err instanceof VaultPathError) return fail(err.code, err.message);
      if (err instanceof SearchError) return fail("SEARCH_ERROR", err.message);
      if (err instanceof Error) return fail("INTERNAL", err.message);
      return fail("INTERNAL", String(err));
    }
  };
}

/** Fuzzy "did you mean" suggestions for a missing note path. */
export function suggestPaths(allPaths: string[], wanted: string, max = 3): string[] {
  const wantedBase = (wanted.split("/").pop() ?? wanted).replace(/\.md$/i, "").toLowerCase();
  return allPaths
    .map((p) => {
      const base = (p.split("/").pop() ?? p).replace(/\.md$/i, "").toLowerCase();
      let score = 0;
      if (base === wantedBase) score = 3;
      else if (base.includes(wantedBase) || wantedBase.includes(base)) score = 2;
      else {
        const a = new Set(wantedBase.split(/\W+/));
        const b = new Set(base.split(/\W+/));
        const overlap = [...a].filter((w) => w && b.has(w)).length;
        if (overlap > 0) score = 1;
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.length - b.p.length)
    .slice(0, max)
    .map((x) => x.p);
}
