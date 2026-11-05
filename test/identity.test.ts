import { describe, expect, test } from "bun:test";
import { connectionName, describeClient, normalizeLabel, redirectHint } from "../src/oauth/identity.ts";

const uris = (...u: string[]) => JSON.stringify(u);

describe("redirectHint", () => {
  test("public host, loopback, custom scheme, junk", () => {
    expect(redirectHint(uris("https://claude.ai/api/mcp/auth_callback"))).toBe("claude.ai");
    expect(redirectHint(uris("http://localhost:33418/callback"))).toBe("local app");
    expect(redirectHint(uris("http://127.0.0.1:5000/cb"))).toBe("local app");
    expect(redirectHint(uris("claude://oauth/callback"))).toBe("claude");
    expect(redirectHint(uris())).toBeNull();
    expect(redirectHint("not json")).toBeNull();
  });
});

describe("describeClient", () => {
  test("same client_name, different surfaces become distinguishable", () => {
    const web = describeClient({ client_name: "Claude", redirect_uris: uris("https://claude.ai/api/mcp/auth_callback") });
    const local = describeClient({
      client_name: "Claude",
      redirect_uris: uris("http://localhost:4000/cb"),
      mcp_client_name: "claude-code",
      mcp_client_version: "2.1.3",
    });
    expect(web).toBe("Claude · claude.ai");
    expect(local).toBe("Claude · local app (claude-code 2.1.3)");
  });

  test("unnamed clients fall back to MCP clientInfo, then redirect host", () => {
    expect(describeClient({ client_name: "Unnamed client", redirect_uris: uris("http://localhost:1/cb"), mcp_client_name: "cursor", mcp_client_version: "1.0" }))
      .toBe("cursor 1.0 · local app");
    expect(describeClient({ client_name: "Unnamed client", redirect_uris: uris("https://app.example.com/cb") })).toBe("app.example.com");
    expect(describeClient({ client_name: "Unnamed client", redirect_uris: uris() })).toBe("Unnamed client");
  });
});

describe("labels", () => {
  test("label wins over the auto name; blank label falls back", () => {
    const c = { client_name: "Claude", redirect_uris: uris("https://claude.ai/cb") };
    expect(connectionName("Work laptop", c)).toBe("Work laptop");
    expect(connectionName("  ", c)).toBe("Claude · claude.ai");
    expect(connectionName(null, c)).toBe("Claude · claude.ai");
  });

  test("normalizeLabel trims, caps, nulls empties", () => {
    expect(normalizeLabel("  Phone  ")).toBe("Phone");
    expect(normalizeLabel("")).toBeNull();
    expect(normalizeLabel(undefined)).toBeNull();
    expect(normalizeLabel("x".repeat(200))!.length).toBe(80);
  });
});
