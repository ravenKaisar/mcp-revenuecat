import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type FakeRevenueCat = {
  url: URL;
  /** Authorization header of every POST, in order. */
  seenAuth: string[];
  /** Every JSON-RPC method that reached the server, in order. */
  seenMethods: string[];
  /** Tool calls that actually executed, with the key that was used. */
  toolCalls: Array<{ auth: string; name: string; args: Record<string, unknown> }>;
  listToolsCalls: number;
  initializeCalls: number;
  /** Live sessions; clear it to simulate an upstream restart (unknown session => 404). */
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Make the next request with this JSON-RPC method fail with an HTTP status. */
  failNext(method: string, status: number): void;
  close(): Promise<void>;
};

/**
 * A stand-in for mcp.revenuecat.ai: stateful Streamable HTTP, Bearer key auth,
 * two pages of tools, and an `echo` tool that reports which key it ran with.
 */
export async function startFakeRevenueCat(validKeys: string[]): Promise<FakeRevenueCat> {
  const keys = new Set(validKeys);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let pendingFailure: { method: string; status: number } | undefined;

  const state: Omit<FakeRevenueCat, "url" | "close"> = {
    seenAuth: [],
    seenMethods: [],
    toolCalls: [],
    listToolsCalls: 0,
    initializeCalls: 0,
    sessions,
    failNext(method, status) {
      pendingFailure = { method, status };
    }
  };

  function buildServer(auth: string) {
    const server = new Server({ name: "fake-revenuecat", version: "0.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      state.listToolsCalls += 1;
      if (request.params?.cursor === "page-2") {
        return {
          tools: [{
            name: "list-apps",
            inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] }
          }]
        };
      }
      return {
        tools: [
          { name: "list-projects", inputSchema: { type: "object" } },
          { name: "echo", inputSchema: { type: "object" } }
        ],
        nextCursor: "page-2"
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      state.toolCalls.push({ auth, name: request.params.name, args });
      if (request.params.name === "boom") {
        return { isError: true, content: [{ type: "text", text: "upstream tool failed" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, auth, args }) }] };
    });

    return server;
  }

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const auth = req.header("authorization") ?? "";
    const method = typeof req.body?.method === "string" ? req.body.method : "";
    state.seenAuth.push(auth);
    state.seenMethods.push(method);

    if (!keys.has(auth.replace(/^Bearer /, ""))) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }

    if (pendingFailure && pendingFailure.method === method) {
      const { status } = pendingFailure;
      pendingFailure = undefined;
      res.status(status).json({ error: `injected ${status}` });
      return;
    }

    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No session" }, id: null });
      return;
    }

    state.initializeCalls += 1;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      }
    });
    await buildServer(auth).connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).end();
  });

  app.delete("/mcp", (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) sessions.delete(sessionId);
    res.status(200).end();
  });

  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const { port } = httpServer.address() as AddressInfo;

  return {
    ...state,
    get seenAuth() { return state.seenAuth; },
    get seenMethods() { return state.seenMethods; },
    get toolCalls() { return state.toolCalls; },
    get listToolsCalls() { return state.listToolsCalls; },
    get initializeCalls() { return state.initializeCalls; },
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    async close() {
      await Promise.allSettled([...sessions.values()].map((transport) => transport.close()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
