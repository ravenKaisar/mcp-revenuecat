import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AccountConfig } from "../config/accounts.js";
import { createGatewayMcpServer } from "../mcp/server.js";
import type { Upstream } from "../upstream/client.js";
import { requireBearerToken } from "./auth.js";

type CreateHttpAppOptions = {
  accounts: AccountConfig;
  serverToken: string;
  upstream: Upstream;
};

export function createHttpApp(options: CreateHttpAppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      accounts: options.accounts.size,
      auth: { tokenConfigured: Boolean(options.serverToken) }
    });
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for this stateless MCP endpoint." },
      id: null
    });
  });

  app.all("/mcp", requireBearerToken(options.serverToken), async (req: Request, res: Response) => {
    try {
      const server = createGatewayMcpServer({ accounts: options.accounts, upstream: options.upstream });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(JSON.stringify({
        event: "mcp_request_error",
        message: error instanceof Error ? error.message : "Internal server error"
      }));

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  return app;
}

function requestLogger(req: Request, res: Response, next: () => void) {
  const requestId = randomUUID();
  const started = Date.now();
  const rpcMethod = typeof req.body === "object" && req.body !== null
    ? (req.body as { method?: unknown }).method
    : undefined;

  res.on("finish", () => {
    console.info(JSON.stringify({
      requestId,
      method: req.method,
      path: req.path,
      rpcMethod,
      statusCode: res.statusCode,
      durationMs: Date.now() - started
    }));
  });

  next();
}
