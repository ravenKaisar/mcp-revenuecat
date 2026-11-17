import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadAccountsFromEnv, parseAccountsConfig } from "../src/config/accounts.js";
import { formatConfigError } from "../src/config/errors.js";

describe("loadAccountsFromEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rc-accounts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the file named by REVENUECAT_ACCOUNTS_FILE", () => {
    const file = join(dir, "accounts.json");
    writeFileSync(file, JSON.stringify([{ id: "a", projectId: "p", apiKey: "sk_file_key_1" }]));
    const accounts = loadAccountsFromEnv({ REVENUECAT_ACCOUNTS_FILE: file });
    expect(accounts.listPublicAccounts()).toEqual([{ id: "a", projectId: "p" }]);
  });

  it("errors when the env var is missing or blank", () => {
    expect(() => loadAccountsFromEnv({})).toThrow(/REVENUECAT_ACCOUNTS_FILE/);
    expect(() => loadAccountsFromEnv({ REVENUECAT_ACCOUNTS_FILE: "   " })).toThrow(/REVENUECAT_ACCOUNTS_FILE/);
  });

  it("errors when the file does not exist", () => {
    expect(() => loadAccountsFromEnv({ REVENUECAT_ACCOUNTS_FILE: join(dir, "missing.json") })).toThrow(/ENOENT/);
  });

  it("loads the shipped example file", () => {
    const accounts = loadAccountsFromEnv({ REVENUECAT_ACCOUNTS_FILE: "secrets/revenuecat_accounts.example.json" });
    expect(accounts.size).toBe(2);
  });
});

describe("parseAccountsConfig edge cases", () => {
  it("trims whitespace around fields", () => {
    const accounts = parseAccountsConfig(JSON.stringify([{ id: " a ", projectId: " p ", apiKey: " sk_trimmed_key " }]));
    expect(accounts.findAccount("a")?.apiKey).toBe("sk_trimmed_key");
    expect(accounts.findByProjectId("p")?.id).toBe("a");
  });

  it.each(["appl_x", "goog_x", "amzn_x", "strp_x", "rcb_x", "test_x"])("rejects public key %s", (apiKey) => {
    expect(() => parseAccountsConfig(JSON.stringify([{ id: "a", projectId: "p", apiKey }]))).toThrow(ZodError);
  });

  it.each([
    ["missing apiKey", { id: "a", projectId: "p" }],
    ["empty id", { id: "", projectId: "p", apiKey: "sk_k_123" }],
    ["blank projectId", { id: "a", projectId: "  ", apiKey: "sk_k_123" }],
    ["number id", { id: 1, projectId: "p", apiKey: "sk_k_123" }]
  ])("rejects %s", (_label, entry) => {
    expect(() => parseAccountsConfig(JSON.stringify([entry]))).toThrow(ZodError);
  });

  it("rejects a single object instead of an array", () => {
    expect(() => parseAccountsConfig(JSON.stringify({ id: "a", projectId: "p", apiKey: "sk_k_123" }))).toThrow(ZodError);
  });

  it("returns undefined for unknown lookups", () => {
    const accounts = parseAccountsConfig(JSON.stringify([{ id: "a", projectId: "p", apiKey: "sk_k_123" }]));
    expect(accounts.findAccount("nope")).toBeUndefined();
    expect(accounts.findByProjectId("a")).toBeUndefined();
  });

  it("keeps the configured order", () => {
    const ids = ["z", "a", "m"];
    const accounts = parseAccountsConfig(JSON.stringify(ids.map((id) => ({ id, projectId: `p-${id}`, apiKey: `sk_key_${id}_1` }))));
    expect(accounts.all().map((account) => account.id)).toEqual(ids);
  });
});

describe("formatConfigError", () => {
  it("lists every zod issue with its path and does not echo key values", () => {
    let error: unknown;
    try {
      parseAccountsConfig(JSON.stringify([{ id: "a", projectId: "p", apiKey: "appl_public" }, { id: "b" }]));
    } catch (caught) {
      error = caught;
    }
    const message = formatConfigError(error);
    expect(message).toContain("0.apiKey: must be a RevenueCat API v2 secret key");
    expect(message).toContain("1.projectId");
    expect(message).toContain("1.apiKey");
    expect(message).not.toContain("appl_public");
  });

  it("uses the message of a plain Error and a fallback otherwise", () => {
    expect(formatConfigError(new Error("Duplicate RevenueCat account id: a"))).toBe("Duplicate RevenueCat account id: a");
    expect(formatConfigError("weird")).toBe("Unknown configuration error");
  });
});
