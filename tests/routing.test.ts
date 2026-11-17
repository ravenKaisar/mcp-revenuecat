import { describe, expect, it } from "vitest";
import { parseAccountsConfig } from "../src/config/accounts.js";
import { isFanOutCall, routeCall, withAccountArg } from "../src/gateway/routing.js";

const two = parseAccountsConfig(JSON.stringify([
  { id: "app-one", projectId: "proj1", apiKey: "sk_one_secret_key" },
  { id: "app-two", projectId: "proj2", apiKey: "sk_two_secret_key" }
]));

describe("routeCall", () => {
  it("uses the explicit account argument and strips it", () => {
    const routed = routeCall(two, { account: "app-two", limit: 5 });
    expect(routed.account.id).toBe("app-two");
    expect(routed.args).toEqual({ limit: 5 });
  });

  it("accepts a projectId as the account argument", () => {
    expect(routeCall(two, { account: "proj1" }).account.id).toBe("app-one");
  });

  it("routes by project_id or projectId and keeps the argument", () => {
    const routed = routeCall(two, { project_id: "proj2" });
    expect(routed.account.id).toBe("app-two");
    expect(routed.args).toEqual({ project_id: "proj2" });
    expect(routeCall(two, { projectId: "proj1" }).account.id).toBe("app-one");
  });

  it("errors on unknown accounts and projects", () => {
    expect(() => routeCall(two, { account: "nope" })).toThrow(/Unknown RevenueCat account/);
    expect(() => routeCall(two, { project_id: "nope" })).toThrow(/No API key configured/);
  });

  it("errors when ambiguous, but falls back to a single account", () => {
    expect(() => routeCall(two, {})).toThrow(/Cannot tell which/);
    const one = parseAccountsConfig(JSON.stringify([{ id: "solo", projectId: "p", apiKey: "sk_solo_key" }]));
    expect(routeCall(one, undefined).account.id).toBe("solo");
  });
});

describe("isFanOutCall", () => {
  it("fans out list-projects only without an explicit account", () => {
    expect(isFanOutCall("list-projects", {})).toBe(true);
    expect(isFanOutCall("list_projects", undefined)).toBe(true);
    expect(isFanOutCall("list-projects", { account: "app-one" })).toBe(false);
    expect(isFanOutCall("list-apps", {})).toBe(false);
  });
});

describe("withAccountArg", () => {
  it("adds an account enum without mutating the upstream schema", () => {
    const tool = { name: "list-apps", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" } } } };
    const result = withAccountArg(tool, two);
    expect(result.inputSchema.properties?.account).toMatchObject({ enum: ["app-one", "app-two"] });
    expect(result.inputSchema.properties?.project_id).toEqual({ type: "string" });
    expect(tool.inputSchema.properties).not.toHaveProperty("account");
  });
});
