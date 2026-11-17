#!/usr/bin/env node
import { loadAccountsFromEnv } from "./config/accounts.js";
import { formatConfigError } from "./config/errors.js";
import { createHttpApp } from "./http/app.js";
import { RevenueCatUpstream } from "./upstream/client.js";

const port = 3000;
const serverToken = process.env.MCP_SERVER_TOKEN;
const upstreamUrl = process.env.REVENUECAT_UPSTREAM_MCP_URL || "https://mcp.revenuecat.ai/mcp";

if (!serverToken) {
  exitWithConfigError("Set MCP_SERVER_TOKEN");
}

const accounts = (() => {
  try {
    return loadAccountsFromEnv();
  } catch (error) {
    return exitWithConfigError(formatConfigError(error));
  }
})();

const upstream = new RevenueCatUpstream({ url: new URL(upstreamUrl) });
const app = createHttpApp({ accounts, serverToken: serverToken!, upstream });

// Kubernetes: preStop sleeps 5s, then SIGTERM; terminationGracePeriodSeconds is 30.
// Drain in-flight requests for up to 20s, leaving headroom before SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 20_000;

const httpServer = app.listen(port, () => {
  console.info(JSON.stringify({
    message: "RevenueCat MCP gateway listening",
    port,
    upstream: upstreamUrl,
    accounts: accounts.size
  }));
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ message: "Shutting down, draining in-flight requests", signal }));

  const forceExit = setTimeout(() => {
    console.error(JSON.stringify({ message: "Shutdown timed out, exiting with requests still open" }));
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stops accepting connections, closes idle keep-alive sockets, and calls back
  // once every in-flight request has finished.
  httpServer.close(() => {
    void upstream.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function exitWithConfigError(message: string): never {
  console.error(JSON.stringify({ error: "Invalid gateway configuration", message }));
  process.exit(1);
}
