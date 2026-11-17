import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RevenueCatAccount } from "../config/accounts.js";

export interface Upstream {
  listTools(account: RevenueCatAccount): Promise<Tool[]>;
  callTool(account: RevenueCatAccount, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

type UpstreamOptions = {
  url: URL;
  toolsTtlMs?: number;
};

export class RevenueCatUpstream implements Upstream {
  private readonly clients = new Map<string, Promise<Client>>();
  private toolsCache?: { tools: Tool[]; expiresAt: number };

  constructor(private readonly options: UpstreamOptions) {}

  async listTools(account: RevenueCatAccount): Promise<Tool[]> {
    if (this.toolsCache && this.toolsCache.expiresAt > Date.now()) {
      return this.toolsCache.tools;
    }

    const tools = await this.withClient(account, true, async (client) => {
      const collected: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        collected.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return collected;
    });

    this.toolsCache = { tools, expiresAt: Date.now() + (this.options.toolsTtlMs ?? 5 * 60_000) };
    return tools;
  }

  async callTool(account: RevenueCatAccount, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.withClient(account, false, async (client) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult
    );
  }

  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(pending.map(async (client) => (await client).close()));
  }

  private async withClient<T>(
    account: RevenueCatAccount,
    idempotent: boolean,
    fn: (client: Client) => Promise<T>
  ): Promise<T> {
    try {
      return await fn(await this.getClient(account));
    } catch (error) {
      await this.dropClient(account.id);
      // A 404 means the upstream session expired and the request was never executed,
      // so it is safe to retry even non-idempotent calls on a fresh session.
      if (idempotent || isSessionExpired(error)) {
        return fn(await this.getClient(account));
      }
      throw error;
    }
  }

  private getClient(account: RevenueCatAccount): Promise<Client> {
    let client = this.clients.get(account.id);
    if (!client) {
      client = this.connect(account);
      this.clients.set(account.id, client);
      client.catch(() => this.clients.delete(account.id));
    }
    return client;
  }

  private async connect(account: RevenueCatAccount): Promise<Client> {
    const client = new Client({ name: "revenuecat-multi-project-gateway", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(this.options.url, {
      requestInit: { headers: { Authorization: `Bearer ${account.apiKey}` } }
    });
    await client.connect(transport);
    return client;
  }

  private async dropClient(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    this.clients.delete(accountId);
    if (client) {
      await client.then((c) => c.close()).catch(() => undefined);
    }
  }
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}
