import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RevenueCatAccount } from "../src/config/accounts.js";
import { RevenueCatUpstream } from "../src/upstream/client.js";
import { startFakeRevenueCat, type FakeRevenueCat } from "./helpers/fakeRevenueCat.js";

const one: RevenueCatAccount = { id: "app-one", projectId: "proj1", apiKey: "sk_one_secret_key" };
const two: RevenueCatAccount = { id: "app-two", projectId: "proj2", apiKey: "sk_two_secret_key" };
const revoked: RevenueCatAccount = { id: "app-revoked", projectId: "proj3", apiKey: "sk_revoked_key_123" };

function parse(result: { content?: unknown }): { tool: string; auth: string; args: Record<string, unknown> } {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text);
}

describe("RevenueCatUpstream", () => {
  let fake: FakeRevenueCat;
  let upstream: RevenueCatUpstream;

  beforeEach(async () => {
    fake = await startFakeRevenueCat([one.apiKey, two.apiKey]);
    upstream = new RevenueCatUpstream({ url: fake.url });
  });

  afterEach(async () => {
    await upstream.close();
    await fake.close();
  });

  describe("authentication", () => {
    it("sends each account's own API key as the Bearer token", async () => {
      expect(parse(await upstream.callTool(one, "echo", {})).auth).toBe(`Bearer ${one.apiKey}`);
      expect(parse(await upstream.callTool(two, "echo", {})).auth).toBe(`Bearer ${two.apiKey}`);
      expect(fake.toolCalls.map((call) => call.auth)).toEqual([`Bearer ${one.apiKey}`, `Bearer ${two.apiKey}`]);
    });

    it("never mixes keys: every request on one account's connection carries that account's key", async () => {
      await upstream.callTool(one, "echo", {});
      await upstream.callTool(two, "echo", {});
      await upstream.callTool(one, "echo", {});
      const keysSeen = new Set(fake.seenAuth);
      expect(keysSeen).toEqual(new Set([`Bearer ${one.apiKey}`, `Bearer ${two.apiKey}`]));
    });

    it("rejects with a 401 error when upstream refuses the key", async () => {
      await expect(upstream.callTool(revoked, "echo", {})).rejects.toSatisfy(
        (error: unknown) => error instanceof StreamableHTTPError && error.code === 401
      );
      expect(fake.toolCalls).toHaveLength(0);
    });

    it("does not cache a failed connection, so the next call reconnects", async () => {
      await expect(upstream.callTool(revoked, "echo", {})).rejects.toThrow();
      await expect(upstream.callTool(revoked, "echo", {})).rejects.toThrow();
      const revokedInits = fake.seenAuth.filter((auth) => auth === `Bearer ${revoked.apiKey}`);
      expect(revokedInits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("connection reuse", () => {
    it("initializes once per account and reuses the session", async () => {
      await upstream.callTool(one, "echo", {});
      await upstream.callTool(one, "echo", {});
      await upstream.callTool(one, "echo", {});
      expect(fake.initializeCalls).toBe(1);

      await upstream.callTool(two, "echo", {});
      expect(fake.initializeCalls).toBe(2);
    });

    it("shares one connection between concurrent first calls", async () => {
      await Promise.all([1, 2, 3, 4].map((n) => upstream.callTool(one, "echo", { n })));
      expect(fake.initializeCalls).toBe(1);
      expect(fake.toolCalls).toHaveLength(4);
    });

    it("forwards arguments unchanged", async () => {
      const args = { project_id: "proj1", nested: { limit: 5, tags: ["a", "b"] } };
      expect(parse(await upstream.callTool(one, "echo", args)).args).toEqual(args);
    });

    it("reconnects after close()", async () => {
      await upstream.callTool(one, "echo", {});
      await upstream.close();
      await upstream.callTool(one, "echo", {});
      expect(fake.initializeCalls).toBe(2);
    });
  });

  describe("listTools", () => {
    it("follows nextCursor and returns every page", async () => {
      const tools = await upstream.listTools(one);
      expect(tools.map((tool) => tool.name)).toEqual(["list-projects", "echo", "list-apps"]);
      expect(fake.listToolsCalls).toBe(2);
    });

    it("caches the tool list across accounts until the TTL expires", async () => {
      await upstream.listTools(one);
      await upstream.listTools(two);
      await upstream.listTools(one);
      expect(fake.listToolsCalls).toBe(2);
    });

    it("refetches once the TTL has expired", async () => {
      const shortLived = new RevenueCatUpstream({ url: fake.url, toolsTtlMs: 0 });
      try {
        await shortLived.listTools(one);
        await shortLived.listTools(one);
        expect(fake.listToolsCalls).toBe(4);
      } finally {
        await shortLived.close();
      }
    });

    it("retries once on any failure, because listing tools is safe to repeat", async () => {
      await upstream.listTools(one);
      const retrying = new RevenueCatUpstream({ url: fake.url, toolsTtlMs: 0 });
      try {
        fake.failNext("tools/list", 502);
        const tools = await retrying.listTools(one);
        expect(tools).toHaveLength(3);
      } finally {
        await retrying.close();
      }
    });
  });

  describe("callTool retries", () => {
    it("retries on a fresh session when the upstream session expired (HTTP 404)", async () => {
      await upstream.callTool(one, "echo", { n: 1 });
      fake.sessions.clear();

      const result = await upstream.callTool(one, "echo", { n: 2 });

      expect(parse(result).args).toEqual({ n: 2 });
      expect(fake.initializeCalls).toBe(2);
      expect(fake.toolCalls.map((call) => call.args)).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("does NOT retry other HTTP errors, so a mutating call can never run twice", async () => {
      await upstream.callTool(one, "echo", {});
      fake.failNext("tools/call", 500);

      await expect(upstream.callTool(one, "echo", { n: 2 })).rejects.toSatisfy(
        (error: unknown) => error instanceof StreamableHTTPError && error.code === 500
      );
      expect(fake.seenMethods.filter((method) => method === "tools/call")).toHaveLength(2);
    });

    it("recovers on the next call after a non-retried failure", async () => {
      fake.failNext("tools/call", 500);
      await expect(upstream.callTool(one, "echo", {})).rejects.toThrow();
      expect(parse(await upstream.callTool(one, "echo", { ok: true })).args).toEqual({ ok: true });
    });

    it("passes a tool-level isError result through without retrying", async () => {
      const result = await upstream.callTool(one, "boom", {});
      expect(result.isError).toBe(true);
      expect(fake.toolCalls.filter((call) => call.name === "boom")).toHaveLength(1);
    });
  });

  it("fails cleanly when the upstream is unreachable", async () => {
    const dead = new RevenueCatUpstream({ url: new URL("http://127.0.0.1:1/mcp") });
    try {
      await expect(dead.callTool(one, "echo", {})).rejects.toThrow();
      await expect(dead.listTools(one)).rejects.toThrow();
    } finally {
      await dead.close();
    }
  });
});
