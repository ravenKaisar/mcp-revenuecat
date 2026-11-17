import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Hashing both sides gives equal-length buffers, so the comparison is constant-time
// and does not reveal the expected token's length.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function requireBearerToken(expectedToken: string) {
  const expectedDigest = digest(expectedToken);

  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    if (!token || !timingSafeEqual(digest(token), expectedDigest)) {
      console.warn(JSON.stringify({
        event: "mcp_auth_failed",
        reason: token ? "token_mismatch" : "missing_bearer_token",
        path: req.path
      }));
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
