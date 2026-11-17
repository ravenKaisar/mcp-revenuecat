import { describe, expect, it, vi } from "vitest";
import { requireBearerToken } from "../src/http/auth.js";

describe("requireBearerToken", () => {
  it("returns 401 for missing or invalid tokens", async () => {
    let statusCode: number | undefined;
    let jsonBody: unknown;
    let nextCalled = false;

    const middleware = requireBearerToken("expected");
    middleware(
      { header: () => undefined } as never,
      {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: unknown) {
          jsonBody = body;
          return this;
        }
      } as never,
      () => {
        nextCalled = true;
      }
    );

    expect(statusCode).toBe(401);
    expect(jsonBody).toEqual({ error: "Unauthorized" });
    expect(nextCalled).toBe(false);
  });

  it("passes valid bearer tokens", () => {
    let nextCalled = false;
    const middleware = requireBearerToken("expected");

    middleware(
      { header: () => "Bearer expected" } as never,
      {} as never,
      () => {
        nextCalled = true;
      }
    );

    expect(nextCalled).toBe(true);
  });

  it("rejects wrong tokens of any length and logs nothing about the expected token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const middleware = requireBearerToken("expected-secret-token");

    for (const header of ["Bearer expected", "Bearer expected-secret-tokenX", "Bearer EXPECTED-SECRET-TOKEN", "Basic expected-secret-token"]) {
      let nextCalled = false;
      let statusCode: number | undefined;
      middleware(
        { header: () => header, path: "/mcp" } as never,
        { status(code: number) { statusCode = code; return this; }, json() { return this; } } as never,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(401);
    }

    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("mcp_auth_failed");
    expect(logged).not.toMatch(/Length|expected-secret-token/);
    warn.mockRestore();
  });
});
