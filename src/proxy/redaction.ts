export const REDACTED = "[redacted]";

export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);

export const SENSITIVE_JSON_KEYS: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "authorization",
  "access_token",
  "refresh_token",
  "token",
  "password",
  "secret",
]);

export function redactHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
        return [name, value];
      }
      return [name, Array.isArray(value) ? value.map(() => REDACTED) : REDACTED];
    }),
  );
}

export function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_JSON_KEYS.has(key.toLowerCase()) ? REDACTED : redactJsonValue(item),
    ]),
  );
}
