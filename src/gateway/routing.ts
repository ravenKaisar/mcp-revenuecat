import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AccountConfig, RevenueCatAccount } from "../config/accounts.js";

export const ACCOUNT_ARG = "account";
const PROJECT_ID_ARGS = ["project_id", "projectId"] as const;
const FAN_OUT_TOOLS = /^list[-_]projects$/;

type ToolArgs = Record<string, unknown>;

export type RoutedCall = {
  account: RevenueCatAccount;
  args: ToolArgs;
};

/**
 * Picks the RevenueCat project for a call, in order: the explicit `account`
 * argument (account id or projectId), then the upstream project id argument,
 * then the only configured account.
 */
export function routeCall(accounts: AccountConfig, rawArgs: ToolArgs | undefined): RoutedCall {
  const { [ACCOUNT_ARG]: accountArg, ...args } = rawArgs ?? {};

  if (typeof accountArg === "string" && accountArg.trim()) {
    const account = accounts.findAccount(accountArg.trim());
    if (!account) {
      throw new Error(`Unknown RevenueCat account "${accountArg}". ${describeAccounts(accounts)}`);
    }
    return { account, args };
  }

  for (const key of PROJECT_ID_ARGS) {
    const projectId = args[key];
    if (typeof projectId === "string" && projectId.trim()) {
      const account = accounts.findByProjectId(projectId.trim());
      if (!account) {
        throw new Error(`No API key configured for RevenueCat project "${projectId}". ${describeAccounts(accounts)}`);
      }
      return { account, args };
    }
  }

  const [only] = accounts.all();
  if (accounts.size === 1 && only) {
    return { account: only, args };
  }

  throw new Error(
    `Cannot tell which RevenueCat project to use. Pass "${ACCOUNT_ARG}" or a project_id. ${describeAccounts(accounts)}`
  );
}

export function isFanOutCall(toolName: string, rawArgs: ToolArgs | undefined): boolean {
  return FAN_OUT_TOOLS.test(toolName) && !rawArgs?.[ACCOUNT_ARG];
}

export function withAccountArg(tool: Tool, accounts: AccountConfig): Tool {
  const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema ?? { type: "object" })) as Tool["inputSchema"];
  inputSchema.properties = {
    ...(inputSchema.properties ?? {}),
    [ACCOUNT_ARG]: {
      type: "string",
      enum: accounts.listPublicAccounts().map((account) => account.id),
      description:
        "Gateway routing: which RevenueCat project's API key to use. Optional when project_id is passed. See list_revenuecat_accounts."
    }
  };
  return { ...tool, inputSchema };
}

function describeAccounts(accounts: AccountConfig): string {
  const list = accounts.listPublicAccounts().map((a) => `${a.id} (${a.projectId})`).join(", ");
  return `Configured: ${list}.`;
}
