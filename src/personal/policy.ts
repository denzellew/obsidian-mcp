import type { Database } from "bun:sqlite";
import type { AuthPrincipal } from "../auth/tokens.ts";

export type Sensitivity = "general" | "private" | "restricted";
export type PersonalAction = "read" | "propose" | "approve";

export interface PersonalPolicy {
  sensitivities: Sensitivity[];
  categories: string[];
  actions: PersonalAction[];
}

const DEFAULT_POLICY: PersonalPolicy = {
  sensitivities: ["general"],
  categories: ["*"],
  actions: ["read", "propose"],
};

function list(value: string, allowed?: readonly string[]): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && (!allowed || allowed.includes(item)))
      : [];
  } catch {
    return [];
  }
}

export function policyFor(db: Database, principal: AuthPrincipal): PersonalPolicy {
  const row = db
    .query<{ sensitivities: string; categories: string; actions: string }, [string, string]>(
      "SELECT sensitivities, categories, actions FROM personal_client_policies WHERE principal_kind = ? AND principal_id = ?",
    )
    .get(principal.kind, principal.id);
  if (!row) return DEFAULT_POLICY;
  return {
    sensitivities: list(row.sensitivities, ["general", "private", "restricted"]) as Sensitivity[],
    categories: list(row.categories),
    actions: list(row.actions, ["read", "propose", "approve"]) as PersonalAction[],
  };
}

export function allows(policy: PersonalPolicy, action: PersonalAction, sensitivity?: string, category?: string): boolean {
  if (!policy.actions.includes(action)) return false;
  if (sensitivity && !policy.sensitivities.includes(sensitivity as Sensitivity)) return false;
  return !category || policy.categories.includes("*") || policy.categories.includes(category);
}
