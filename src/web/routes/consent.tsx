import { Layout } from "../layout.tsx";
import type { ClientRow } from "../../oauth/router.ts";
import { MAX_LABEL_CHARS } from "../../oauth/identity.ts";

export function ConsentPage(props: { client: ClientRow; vaultName: string; params: Record<string, string>; suggestedLabel: string }) {
  const redirectHost = (() => {
    try {
      return new URL(props.params.redirect_uri ?? "").host;
    } catch {
      return "unknown";
    }
  })();
  return (
    <Layout title="Authorize" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-base-700 bg-base-900 p-8">
        <div class="mb-6 flex items-center gap-3">
          <img src="/assets/logo.svg" alt="" class="h-8 w-8" />
          <h1 class="text-lg font-semibold">Authorize access</h1>
        </div>
        <p class="mb-2">
          <span class="font-semibold text-accent-hover">{props.client.client_name}</span> wants full access to your
          Obsidian vault <span class="font-semibold text-text">{props.vaultName}</span> via MCP (read, create, edit, and
          delete notes).
        </p>
        <p class="mb-6 text-sm text-text-muted">
          After approval you will be sent to <span class="font-mono">{redirectHost}</span>. Approving remembers this
          client for this vault only; revoke it anytime under Connections.
        </p>
        <form method="post" action="/oauth/consent" class="space-y-4">
          {Object.entries(props.params)
            .filter(([k]) => k !== "label")
            .map(([k, v]) => (
              <input type="hidden" name={k} value={v} />
            ))}
          <label class="block">
            <span class="mb-1 block text-sm text-text-muted">Name this connection</span>
            <input
              type="text"
              name="label"
              value={props.suggestedLabel}
              maxlength={MAX_LABEL_CHARS}
              class="w-full rounded-md border border-base-600 bg-base-950 px-3 py-2 text-sm"
            />
            <span class="mt-1 block text-xs text-text-muted">
              Shown in Connections and the audit log, so you can tell clients apart. You can rename it later.
            </span>
          </label>
          <div class="flex gap-3">
          <button
            type="submit"
            name="decision"
            value="approve"
            class="flex-1 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            class="flex-1 rounded-md border border-base-600 px-4 py-2 font-medium text-text-muted hover:text-text"
          >
            Deny
          </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

export function OAuthErrorPage(props: { message: string }) {
  return (
    <Layout title="Authorization error" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-danger/40 bg-base-900 p-8">
        <h1 class="mb-3 text-lg font-semibold text-danger">Authorization error</h1>
        <p class="text-text-muted">{props.message}</p>
      </div>
    </Layout>
  );
}
