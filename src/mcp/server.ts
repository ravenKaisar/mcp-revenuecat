import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AccountConfig } from "../config/accounts.js";
import { redactSecrets } from "../gateway/redact.js";
import { isFanOutCall, routeCall, withAccountArg } from "../gateway/routing.js";
import type { Upstream } from "../upstream/client.js";

export const LIST_ACCOUNTS_TOOL = "list_revenuecat_accounts";

type GatewayServerOptions = {
  accounts: AccountConfig;
  upstream: Upstream;
};

export function createGatewayMcpServer(options: GatewayServerOptions): Server {
  const server = new Server(
    { name: "revenuecat-multi-project-gateway", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "RevenueCat tools for several projects, each with its own API key. Calls are routed by project_id; " +
        `call ${LIST_ACCOUNTS_TOOL} or list-projects to see the projects, or pass "account" explicitly.`
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listGatewayTools(options)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === LIST_ACCOUNTS_TOOL) {
      return textResult(options.accounts.listPublicAccounts());
    }

    try {
      if (isFanOutCall(name, args)) {
        return await fanOut(options, name, args ?? {});
      }
      const routed = routeCall(options.accounts, args);
      const result = await options.upstream.callTool(routed.account, name, routed.args);
      return redactSecrets(result) as CallToolResult;
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Tool call failed.");
    }
  });

  return server;
}

async function listGatewayTools(options: GatewayServerOptions): Promise<Tool[]> {
  const upstreamTools = await fetchUpstreamTools(options);
  return [
    {
      name: LIST_ACCOUNTS_TOOL,
      description: "List the RevenueCat projects this gateway holds API keys for (account id and projectId, no secrets).",
      inputSchema: { type: "object", properties: {} }
    },
    ...upstreamTools.map((tool) => withAccountArg(tool, options.accounts))
  ];
}

// The tool catalog is the same for every project, so any account's key can list it.
// Try accounts in order so one revoked or rate-limited key doesn't hide every tool.
async function fetchUpstreamTools(options: GatewayServerOptions): Promise<Tool[]> {
  let lastError: unknown;
  for (const account of options.accounts.all()) {
    try {
      return await options.upstream.listTools(account);
    } catch (error) {
      lastError = error;
      console.warn(JSON.stringify(redactSecrets({
        event: "upstream_list_tools_failed",
        account: account.id,
        error: error instanceof Error ? error.message : String(error)
      })));
    }
  }
  if (lastError !== undefined) throw lastError;
  return [];
}

async function fanOut(options: GatewayServerOptions, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const accounts = options.accounts.all();
  const results = await Promise.allSettled(
    accounts.map((account) => options.upstream.callTool(account, name, args))
  );

  const content: CallToolResult["content"] = [];
  let failures = 0;
  results.forEach((result, index) => {
    const account = accounts[index]!;
    const label = `[${account.id} · ${account.projectId}]`;
    if (result.status === "fulfilled" && !result.value.isError) {
      content.push({ type: "text", text: label }, ...(result.value.content ?? []));
    } else {
      failures += 1;
      const reason = result.status === "rejected"
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : JSON.stringify(result.value.content);
      content.push({ type: "text", text: `${label} error: ${reason}` });
    }
  });

  return redactSecrets({ content, isError: failures === accounts.length }) as CallToolResult;
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(redactSecrets(value), null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: String(redactSecrets(message)) }] };
}
