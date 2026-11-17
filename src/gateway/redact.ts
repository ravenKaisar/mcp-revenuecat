// Property names whose values are always secret. Compared after lowercasing and
// dropping "_" and "-", so apiKey, api_key and API-Key all match. Exact names only:
// a substring match would also hide fields like next_page_token or token_count.
const SECRET_KEYS = new Set([
  "apikey",
  "secretkey",
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "idtoken",
  "secret",
  "clientsecret",
  "password"
]);
const SECRET_VALUE = /\bsk_[A-Za-z0-9_-]{8,}/g;

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "[REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretKey(key) ? "[REDACTED]" : redactSecrets(item)
    ])
  );
}
