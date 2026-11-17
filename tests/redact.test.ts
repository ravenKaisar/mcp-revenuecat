import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/gateway/redact.js";

describe("redactSecrets", () => {
  it("masks sk_ keys inside strings, including keys with _ and -", () => {
    expect(redactSecrets("key sk_abcDEF123456 used")).toBe("key [REDACTED] used");
    expect(redactSecrets("sk_two_secret_key")).toBe("[REDACTED]");
    expect(redactSecrets("sk_with-dash-1234")).toBe("[REDACTED]");
  });

  it("masks every key in a string", () => {
    expect(redactSecrets("a=sk_aaaaaaaaaa b=sk_bbbbbbbbbb")).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("leaves short or unrelated sk_ text alone", () => {
    expect(redactSecrets("sk_short")).toBe("sk_short");
    expect(redactSecrets("task_1234567890")).toBe("task_1234567890");
    expect(redactSecrets("disk_usage")).toBe("disk_usage");
  });

  it("masks values of secret-looking property names at any depth", () => {
    const input = {
      apiKey: "anything",
      api_key: "anything",
      Authorization: "Bearer x",
      access_token: "t",
      client_secret: "s",
      nested: { list: [{ apiKey: "deep", name: "keep" }] }
    };
    expect(redactSecrets(input)).toEqual({
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      Authorization: "[REDACTED]",
      access_token: "[REDACTED]",
      client_secret: "[REDACTED]",
      nested: { list: [{ apiKey: "[REDACTED]", name: "keep" }] }
    });
  });

  it("matches secret names case- and separator-insensitively", () => {
    expect(redactSecrets({ "API-Key": "x", REFRESH_TOKEN: "y", token: "z", password: "p" })).toEqual({
      "API-Key": "[REDACTED]",
      REFRESH_TOKEN: "[REDACTED]",
      token: "[REDACTED]",
      password: "[REDACTED]"
    });
  });

  it("keeps fields that only contain a secret word, like pagination cursors and counters", () => {
    const input = { next_page_token: "cursor-abc", token_count: 12, starting_after: "x", secret_santa_enabled: false };
    expect(redactSecrets(input)).toEqual(input);
  });

  it("keeps non-secret data, primitives and null intact", () => {
    expect(redactSecrets({ id: "proj1", count: 3, active: true, none: null })).toEqual({
      id: "proj1",
      count: 3,
      active: true,
      none: null
    });
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const input = { apiKey: "sk_original_key_1", text: "sk_original_key_1" };
    redactSecrets(input);
    expect(input).toEqual({ apiKey: "sk_original_key_1", text: "sk_original_key_1" });
  });
});
