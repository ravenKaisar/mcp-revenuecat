# mcp-revenuecat

One MCP endpoint for many RevenueCat projects. RevenueCat's hosted MCP server
(`https://mcp.revenuecat.ai/mcp`) takes one API v2 key per connection, and each
key belongs to one project. This gateway holds one key per project and sends
each tool call upstream with the right key.

Image: `ghcr.io/ravenkaisar/mcp-revenuecat`.

## How calls are routed

- `tools/list` returns RevenueCat's tool list (fetched with the first key, cached 5 min).
  Every tool gets an extra optional `account` argument, and there is one extra tool,
  `list_revenuecat_accounts`, which returns each account's id and projectId (never the keys).
- `tools/call` picks the key in this order:
  1. the `account` argument (account id or projectId), which is removed before forwarding;
  2. a `project_id` / `projectId` argument that matches a configured project;
  3. the only account, if just one is configured;
  4. otherwise it returns an error that lists the configured accounts.
- `list-projects` without `account` is sent to every account and the results are merged,
  each labelled `[id · projectId]`. It only fails if every account fails.
- Results and errors are scrubbed of anything that looks like an `sk_` key.

## Configuration

| Env var | Purpose |
|---|---|
| `MCP_SERVER_TOKEN` | Required. Bearer token clients (agentgateway) must send. |
| `REVENUECAT_ACCOUNTS_FILE` | Required. Path to the accounts JSON. |
| `REVENUECAT_UPSTREAM_MCP_URL` | Default `https://mcp.revenuecat.ai/mcp`. |

Accounts file (see `secrets/revenuecat_accounts.example.json`):

```json
[{ "id": "app-one", "projectId": "proj1a2b3c4d", "apiKey": "sk_..." }]
```

Keys must be RevenueCat **API v2 secret keys** (`sk_...`). Public SDK keys
(`appl_`, `goog_`, …) are rejected at startup. Ids and projectIds must be unique.

## Develop

```sh
pnpm install
pnpm test
cp secrets/revenuecat_accounts.example.json secrets/revenuecat_accounts.json   # fill in real keys
REVENUECAT_ACCOUNTS_FILE=secrets/revenuecat_accounts.json pnpm validate:config
MCP_SERVER_TOKEN=dev REVENUECAT_ACCOUNTS_FILE=secrets/revenuecat_accounts.json pnpm dev
```

Or `MCP_SERVER_TOKEN=dev docker compose up --build`.

Listens on fixed port 3000. Endpoints: `GET /healthz`, `POST /mcp` (stateless Streamable HTTP, JSON responses).

## Publish

`.github/workflows/docker-publish.yml` tests, then pushes multi-arch images to
GHCR and Docker Hub on pushes to `main` (image tag `latest`) and on `vX.Y.Z` git
tags (image tag `vX.Y.Z`, plus npm publish of version `X.Y.Z`). Needs
`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and `NPM_TOKEN` repo secrets.

```sh
git tag v1.0.0 && git push origin v1.0.0
```
