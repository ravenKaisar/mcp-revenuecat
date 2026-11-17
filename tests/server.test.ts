import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseAccountsConfig, type RevenueCatAccount } from "../src/config/accounts.js";
import { createGatewayMcpServer, LIST_ACCOUNTS_TOOL } from "../src/mcp/server.js";
import type { Upstream } from "../src/upstream/client.js";

const accounts = parseAccountsConfig(JSON.stringify([
  { id: "app-one", projectId: "proj1", apiKey: "sk_one_secret_key" },
  { id: "app-two", projectId: "proj2", apiKey: "sk_two_secret_key" }
]));

class FakeUpstream implements Upstream {
  calls: Array<{ account: string; name: string; args: Record<string, unknown> }> = [];
  failFor = new Set<string>();

  async listTools(): Promise<Tool[]> {
    return [
      { name: "list-projects", inputSchema: { type: "object" } },
      { name: "list-apps", inputSchema: { type: "object", properties: { project_id: { type: "string" } } } }
    ];
  }

  async callTool(account: RevenueCatAccount, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ account: account.id, name, args });
    if (this.failFor.has(account.id)) {
      throw new Error(`upstream down, key ${account.apiKey}`);
    }
    return { content: [{ type: "text", text: `${name}@${account.projectId}` }] };
  }

  async close(): Promise<void> {}
}

async function connect(upstream: Upstream) {
  const server = createGatewayMcpServer({ accounts, upstream });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function texts(result: unknown): string[] {
  return ((result as CallToolResult).content ?? []).map((item) => (item.type === "text" ? item.text : ""));
}

describe("gateway MCP server", () => {
  it("lists upstream tools with an account argument plus the accounts tool", async () => {
    const client = await connect(new FakeUpstream());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([LIST_ACCOUNTS_TOOL, "list-projects", "list-apps"]);
    expect(tools[2]?.inputSchema.properties).toHaveProperty("account");
  });

  it("lists accounts without keys", async () => {
    const client = await connect(new FakeUpstream());
    const result = await client.callTool({ name: LIST_ACCOUNTS_TOOL, arguments: {} });
    expect(texts(result).join()).toContain("proj2");
    expect(texts(result).join()).not.toContain("sk_");
  });

  it("routes a call to the project's key", async () => {
    const upstream = new FakeUpstream();
    const client = await connect(upstream);
    const result = await client.callTool({ name: "list-apps", arguments: { project_id: "proj2" } });
    expect(texts(result)).toEqual(["list-apps@proj2"]);
    expect(upstream.calls).toEqual([{ account: "app-two", name: "list-apps", args: { project_id: "proj2" } }]);
  });

  it("returns a tool error when the project is ambiguous", async () => {
    const client = await connect(new FakeUpstream());
    const result = await client.callTool({ name: "list-apps", arguments: {} });
    expect(result.isError).toBe(true);
    expect(texts(result).join()).toContain("app-one (proj1)");
  });

  it("fans list-projects out to every account and redacts failures", async () => {
    const upstream = new FakeUpstream();
    upstream.failFor.add("app-two");
    const client = await connect(upstream);
    const result = await client.callTool({ name: "list-projects", arguments: {} });
    const output = texts(result).join("\n");
    expect(result.isError).toBe(false);
    expect(output).toContain("list-projects@proj1");
    expect(output).toContain("[app-two · proj2] error");
    expect(output).not.toContain("sk_two_secret_key");
  });

  describe("fan-out details", () => {
    it("labels each project's block in configured order", async () => {
      const client = await connect(new FakeUpstream());
      const result = await client.callTool({ name: "list-projects", arguments: {} });
      expect(texts(result)).toEqual([
        "[app-one · proj1]",
        "list-projects@proj1",
        "[app-two · proj2]",
        "list-projects@proj2"
      ]);
      expect(result.isError).toBe(false);
    });

    it("sets isError only when every project fails", async () => {
      const upstream = new FakeUpstream();
      upstream.failFor.add("app-one");
      upstream.failFor.add("app-two");
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(texts(result)).toHaveLength(2);
      expect(texts(result).join()).not.toContain("sk_");
    });

    it("counts an upstream isError result as a failure for that project", async () => {
      const upstream = new FakeUpstream();
      upstream.callTool = async (account, name) =>
        account.id === "app-one"
          ? { isError: true, content: [{ type: "text", text: "permission denied" }] }
          : { content: [{ type: "text", text: `${name}@${account.projectId}` }] };
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-projects", arguments: {} });
      const output = texts(result).join("\n");
      expect(result.isError).toBe(false);
      expect(output).toContain("[app-one · proj1] error:");
      expect(output).toContain("permission denied");
      expect(output).toContain("list-projects@proj2");
    });

    it("also fans out the underscore spelling list_projects", async () => {
      const upstream = new FakeUpstream();
      const client = await connect(upstream);
      await client.callTool({ name: "list_projects", arguments: {} });
      expect(upstream.calls.map((call) => call.account)).toEqual(["app-one", "app-two"]);
    });

    it("does not fan out when an account is given, and strips the account arg", async () => {
      const upstream = new FakeUpstream();
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-projects", arguments: { account: "app-two" } });
      expect(texts(result)).toEqual(["list-projects@proj2"]);
      expect(upstream.calls).toEqual([{ account: "app-two", name: "list-projects", args: {} }]);
    });
  });

  describe("single-project calls", () => {
    it("routes by account id or projectId passed as account", async () => {
      const upstream = new FakeUpstream();
      const client = await connect(upstream);
      await client.callTool({ name: "list-apps", arguments: { account: "app-one", limit: 5 } });
      await client.callTool({ name: "list-apps", arguments: { account: "proj2" } });
      expect(upstream.calls).toEqual([
        { account: "app-one", name: "list-apps", args: { limit: 5 } },
        { account: "app-two", name: "list-apps", args: {} }
      ]);
    });

    it("returns a tool error for an unknown project without calling upstream", async () => {
      const upstream = new FakeUpstream();
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-apps", arguments: { project_id: "nope" } });
      expect(result.isError).toBe(true);
      expect(texts(result).join()).toContain('"nope"');
      expect(upstream.calls).toHaveLength(0);
    });

    it("turns an upstream exception into a redacted tool error", async () => {
      const upstream = new FakeUpstream();
      upstream.failFor.add("app-one");
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-apps", arguments: { project_id: "proj1" } });
      expect(result.isError).toBe(true);
      expect(texts(result).join()).toContain("upstream down");
      expect(texts(result).join()).not.toContain("sk_one_secret_key");
    });

    it("redacts secrets that appear in a successful upstream result", async () => {
      const upstream = new FakeUpstream();
      upstream.callTool = async () => ({
        content: [{ type: "text", text: "webhook auth sk_leaked_value_1234" }],
        structuredContent: { apiKey: "anything", app: "ok" }
      });
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-apps", arguments: { project_id: "proj1" } });
      expect(texts(result)).toEqual(["webhook auth [REDACTED]"]);
      expect(result.structuredContent).toEqual({ apiKey: "[REDACTED]", app: "ok" });
    });

    it("passes an upstream isError result through unchanged", async () => {
      const upstream = new FakeUpstream();
      upstream.callTool = async () => ({ isError: true, content: [{ type: "text", text: "not found" }] });
      const client = await connect(upstream);
      const result = await client.callTool({ name: "list-apps", arguments: { project_id: "proj1" } });
      expect(result.isError).toBe(true);
      expect(texts(result)).toEqual(["not found"]);
    });
  });

  it("uses the first account to list tools and returns an empty accounts tool schema", async () => {
    const upstream = new FakeUpstream();
    const seen: string[] = [];
    upstream.listTools = async (account?: RevenueCatAccount) => {
      seen.push(account!.id);
      return [];
    };
    const client = await connect(upstream);
    const { tools } = await client.listTools();
    expect(seen).toEqual(["app-one"]);
    expect(tools).toEqual([expect.objectContaining({ name: LIST_ACCOUNTS_TOOL, inputSchema: { type: "object", properties: {} } })]);
  });

  it("falls back to the next account when listing tools fails for the first one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upstream = new FakeUpstream();
    const seen: string[] = [];
    upstream.listTools = async (account?: RevenueCatAccount) => {
      seen.push(account!.id);
      if (account!.id === "app-one") throw new Error("401 invalid key sk_leakedkey12345");
      return [{ name: "list-projects", inputSchema: { type: "object", properties: {} } }];
    };
    const client = await connect(upstream);
    const { tools } = await client.listTools();
    expect(seen).toEqual(["app-one", "app-two"]);
    expect(tools.map((tool) => tool.name)).toEqual([LIST_ACCOUNTS_TOOL, "list-projects"]);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("upstream_list_tools_failed");
    expect(logged).toContain("app-one");
    expect(logged).not.toContain("sk_leakedkey12345");
    warn.mockRestore();
  });
});
