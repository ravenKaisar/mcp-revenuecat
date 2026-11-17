import { describe, expect, it } from "vitest";
import { parseAccountsConfig } from "../src/config/accounts.js";

const valid = [
  { id: "app-one", projectId: "proj1", apiKey: "sk_one_secret_key" },
  { id: "app-two", projectId: "proj2", apiKey: "sk_two_secret_key" }
];

describe("parseAccountsConfig", () => {
  it("loads accounts and looks them up by id or projectId", () => {
    const accounts = parseAccountsConfig(JSON.stringify(valid));
    expect(accounts.size).toBe(2);
    expect(accounts.findAccount("app-two")?.projectId).toBe("proj2");
    expect(accounts.findAccount("proj1")?.id).toBe("app-one");
  });

  it("never exposes API keys in the public listing", () => {
    const accounts = parseAccountsConfig(JSON.stringify(valid));
    expect(JSON.stringify(accounts.listPublicAccounts())).not.toContain("sk_");
  });

  it("rejects public SDK keys", () => {
    expect(() => parseAccountsConfig(JSON.stringify([{ id: "a", projectId: "p", apiKey: "appl_abc" }])))
      .toThrow(/secret key/);
  });

  it("rejects duplicate ids and projectIds", () => {
    expect(() => parseAccountsConfig(JSON.stringify([valid[0], { ...valid[1], id: "app-one" }])))
      .toThrow(/Duplicate/);
    expect(() => parseAccountsConfig(JSON.stringify([valid[0], { ...valid[1], projectId: "proj1" }])))
      .toThrow(/same projectId/);
  });

  it("rejects unknown fields, empty lists and invalid JSON", () => {
    expect(() => parseAccountsConfig(JSON.stringify([{ ...valid[0], extra: 1 }]))).toThrow();
    expect(() => parseAccountsConfig("[]")).toThrow();
    expect(() => parseAccountsConfig("{not json")).toThrow(/valid JSON/);
  });
});
