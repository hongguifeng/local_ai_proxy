export const REDACTED = "[redacted]";

export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
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
