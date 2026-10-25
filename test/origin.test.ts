import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { createApp } from "../src/app.tsx";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { VaultStore } from "../src/vault/store.ts";
import { LinkIndex } from "../src/vault/links.ts";
import { Snapshotter } from "../src/snapshots/snapshotter.ts";
import { createVaultContext } from "../src/mcp/context.ts";
import { resolveOrigin } from "../src/web/origin.ts";
import { getSetting, setSetting } from "../src/db/index.ts";
import { resetAuth } from "../src/auth/webauthn.ts";
import { resetRateLimits } from "../src/auth/middleware.ts";
import { tmpVault, type TmpVault } from "./helpers.ts";
import type { Database } from "bun:sqlite";

/** Minimal Context stub exposing just the header lookup resolveOrigin needs. */
function fakeCtx(headers: Record<string, string>): Context {
  return { req: { header: (n: string) => headers[n.toLowerCase()] } } as unknown as Context;
}

describe("resolveOrigin", () => {
  test("fixed mode ignores request headers", () => {
    const config = loadConfig({ PUBLIC_URL: "https://notes.example.com" } as NodeJS.ProcessEnv);
    const r = resolveOrigin(fakeCtx({ "x-forwarded-host": "evil.com", host: "evil.com" }), config);
    expect(r.origin).toBe("https://notes.example.com");
    expect(r.rpId).toBe("notes.example.com");
    expect(r.secure).toBe(true);
  });

  test("derived mode uses X-Forwarded-Proto/Host", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.derived).toBe(true);
    const r = resolveOrigin(
      fakeCtx({ "x-forwarded-proto": "https", "x-forwarded-host": "obsmcp.example.net", host: "internal:3000" }),
      config,
    );
    expect(r.origin).toBe("https://obsmcp.example.net");
    expect(r.rpId).toBe("obsmcp.example.net");
    expect(r.secure).toBe(true);
  });

  test("derived mode falls back to Host, assumes https for non-localhost", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const r = resolveOrigin(fakeCtx({ host: "notes.example.org" }), config);
    expect(r.origin).toBe("https://notes.example.org");
  });

  test("derived mode treats localhost as http", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const r = resolveOrigin(fakeCtx({ host: "localhost:3000" }), config);
    expect(r.origin).toBe("http://localhost:3000");
    expect(r.secure).toBe(false);
  });

  test("first X-Forwarded-Host hop wins", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const r = resolveOrigin(fakeCtx({ "x-forwarded-host": "real.example.com, fake.example.com", "x-forwarded-proto": "https" }), config);
    expect(r.rpId).toBe("real.example.com");
  });
});

describe("derived mode end-to-end (behind a proxy)", () => {
  let vault: TmpVault;
  let snapsDir: string;
  let db: Database;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const PROXY = "obsmcp-dev.onewheelgeek.net";

  beforeAll(async () => {
    vault = tmpVault({ "Note.md": "hello\n" });
    snapsDir = mkdtempSync(join(tmpdir(), "obmcp-snaps-"));
    db = openDatabase(":memory:");
    const store = new VaultStore(vault.dir);
    const snapshotter = new Snapshotter(snapsDir, vault.dir, { debounceMs: 50, maxWaitMs: 500, intervalMs: 600_000 });
    await snapshotter.init();
    const vaultCtx = createVaultContext({ store, links: new LinkIndex(store), snapshotter });
    const config = loadConfig({ DATA_DIR: vault.dir } as unknown as NodeJS.ProcessEnv); // no PUBLIC_URL → derived
    const app = createApp({ config, db, vaultCtx, setupState: { token: "setup_x", pendingUserHandle: null } });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    vault?.cleanup();
    rmSync(snapsDir, { recursive: true, force: true });
  });

  beforeEach(() => resetRateLimits());

  /** Simulate a request arriving through the reverse proxy. */
  function proxied(path: string, init: RequestInit = {}) {
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": PROXY,
        ...(init.headers ?? {}),
      },
    });
  }

  test("OAuth metadata reflects the proxy hostname, not localhost", async () => {
    const prm = (await (await proxied("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`https://${PROXY}/mcp`);
    expect(prm.authorization_servers).toEqual([`https://${PROXY}`]);

    const as = (await (await proxied("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(`https://${PROXY}`);
    expect(as.authorization_endpoint).toBe(`https://${PROXY}/oauth/authorize`);
  });

  test("WWW-Authenticate points at the proxy host", async () => {
    const res = await proxied("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`https://${PROXY}/.well-known`);
  });

  test("setup registration options use the proxy host as rpID", async () => {
    const res = await proxied("/setup/webauthn/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupToken: "setup_x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: { rp: { id: string } } };
    expect(body.options.rp.id).toBe(PROXY); // <-- the bug from the report: now correct
  });

  test("rpID pinning: once pinned, a different proxy host is rejected", async () => {
    // simulate setup having completed under the proxy host
    setSetting(db, "rp_id_at_setup", PROXY);
    db.query("INSERT OR IGNORE INTO users (id, display_name, user_handle) VALUES (1, 'Owner', X'00')").run();
    db.query("INSERT OR IGNORE INTO passkey_credentials (id, user_id, name, public_key, counter) VALUES ('c1', 1, 'k', X'00', 0)").run();

    // a request arriving with a DIFFERENT forwarded host is refused by the host guard
    const res = await fetch(`${base}/login/webauthn/options`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example.com" },
    });
    expect(res.status).toBe(421);

    // the legitimate proxy host still works
    const ok = await proxied("/login/webauthn/options", { method: "POST" });
    expect(ok.status).toBe(200);
  });

  test("AUTH_RESET clears the pinned hostname", async () => {
    setSetting(db, "rp_id_at_setup", PROXY);
    resetAuth(db);
    expect(getSetting(db, "rp_id_at_setup")).toBeNull();

    const res = await fetch(`${base}/login/webauthn/options`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example.com" },
    });
    expect(res.status).not.toBe(421);
  });
});
