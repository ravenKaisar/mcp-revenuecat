import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseAccountsConfig, type RevenueCatAccount } from "../src/config/accounts.js";
import { createHttpApp } from "../src/http/app.js";
import type { Upstream } from "../src/upstream/client.js";

const TOKEN = "gateway-token-123";
const accounts = parseAccountsConfig(JSON.stringify([
  { id: "app-one", projectId: "proj1", apiKey: "sk_one_secret_key" },
  { id: "app-two", projectId: "proj2", apiKey: "sk_two_secret_key" }
]));

class RecordingUpstream implements Upstream {
  calls: Array<{ account: string; name: string; args: Record<string, unknown> }> = [];
  listToolsError: Error | undefined;

  async listTools(): Promise<Tool[]> {
    if (this.listToolsError) throw this.listToolsError;
    return [{ name: "list-apps", inputSchema: { type: "object", properties: { project_id: { type: "string" } } } }];
  }

  async callTool(account: RevenueCatAccount, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ account: account.id, name, args });
    return { content: [{ type: "text", text: `ok from ${account.projectId}` }] };
  }

  async close(): Promise<void> {}
}

const upstream = new RecordingUpstream();
let server: HttpServer;
let base: string;
let nextId = 1;

async function rpc(method: string, params: unknown = {}, token: string | null = TOKEN) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  server = createHttpApp({ accounts, serverToken: TOKEN, upstream }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

beforeEach(() => {
  upstream.calls = [];
  upstream.listToolsError = undefined;
});

describe("GET /healthz", () => {
  it("reports status and account count without auth", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", accounts: 2, auth: { tokenConfigured: true } });
  });

  it("never leaks the gateway token or API keys", async () => {
    const text = await (await fetch(`${base}/healthz`)).text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("sk_");
  });

  it("does not advertise Express", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.headers.get("x-powered-by")).toBeNull();
  });
});

describe("/mcp transport rules", () => {
  it("returns 405 for GET (no SSE stream in stateless mode)", async () => {
    const response = await fetch(`${base}/mcp`);
    expect(response.status).toBe(405);
    expect((await response.json()).error.message).toMatch(/Use POST/);
  });

  it("returns 401 without a bearer token", async () => {
    const { status, body } = await rpc("tools/list", {}, null);
    expect(status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(upstream.calls).toHaveLength(0);
  });

  it("returns 401 for a wrong token", async () => {
    expect((await rpc("tools/list", {}, "wrong")).status).toBe(401);
  });

  it("returns 401 when the scheme is not Bearer", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Basic ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(401);
  });

  it("does not issue a session id (stateless)", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("/mcp JSON-RPC", () => {
  it("initializes with the gateway's name and routing instructions", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    });
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("revenuecat-multi-project-gateway");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.instructions).toMatch(/project_id/);
  });

  it("lists the accounts tool plus upstream tools with an account enum", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((tool: Tool) => tool.name);
    expect(names).toEqual(["list_revenuecat_accounts", "list-apps"]);
    expect(body.result.tools[1].inputSchema.properties.account.enum).toEqual(["app-one", "app-two"]);
  });

  it("routes tools/call by project_id over HTTP", async () => {
    const { body } = await rpc("tools/call", { name: "list-apps", arguments: { project_id: "proj2" } });
    expect(body.result.content[0].text).toBe("ok from proj2");
    expect(upstream.calls).toEqual([{ account: "app-two", name: "list-apps", args: { project_id: "proj2" } }]);
  });

  it("returns a JSON-RPC error when the upstream tool list cannot be fetched", async () => {
    upstream.listToolsError = new Error("upstream down");
    const { status, body } = await rpc("tools/list");
    expect(status).toBe(200);
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
  });

  it("handles parallel requests independently", async () => {
    const results = await Promise.all([
      rpc("tools/call", { name: "list-apps", arguments: { account: "app-one" } }),
      rpc("tools/call", { name: "list-apps", arguments: { account: "app-two" } }),
      rpc("tools/call", { name: "list-apps", arguments: { project_id: "proj1" } })
    ]);
    expect(results.map((r) => r.body.result.content[0].text)).toEqual([
      "ok from proj1",
      "ok from proj2",
      "ok from proj1"
    ]);
  });

  it("rejects bodies over 1mb", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_100_000) })
    });
    expect(response.status).toBe(413);
  });
});
