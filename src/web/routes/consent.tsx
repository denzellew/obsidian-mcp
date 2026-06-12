import { Layout } from "../layout.tsx";
import type { ClientRow } from "../../oauth/router.ts";

export function ConsentPage(props: { client: ClientRow; params: Record<string, string> }) {
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
          Obsidian vault via MCP (read, create, edit, and delete notes).
        </p>
        <p class="mb-6 text-sm text-text-muted">
          After approval you will be sent to <span class="font-mono">{redirectHost}</span>. Approving remembers this
          client; revoke it anytime under Connections.
        </p>
        <form method="post" action="/oauth/consent" class="flex gap-3">
          {Object.entries(props.params).map(([k, v]) => (
            <input type="hidden" name={k} value={v} />
          ))}
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
