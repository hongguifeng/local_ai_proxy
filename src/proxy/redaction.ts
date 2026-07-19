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

export function redactBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted = { ...body };
  const text = redacted["text"];
  if (typeof text !== "string" || text === "") {
    return redacted;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redacted;
  }
  const redactedText = JSON.stringify(redactJsonValue(parsed));
  redacted["text"] = redactedText;
  redacted["base64"] = "";
  redacted["size_bytes"] = Buffer.byteLength(redactedText, "utf8");
  return redacted;
}

export function redactRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted = structuredClone(record);
  for (const sectionName of ["request", "response"] as const) {
    const section = redacted[sectionName];
    if (!isRecord(section)) {
      continue;
    }
    if (isRecord(section["headers"])) {
      section["headers"] = redactHeaders(section["headers"]);
    }
    if (isRecord(section["body"])) {
      section["body"] = redactBody(section["body"]);
    }
    if (isRecord(section["upstream_body"])) {
      section["upstream_body"] = redactBody(section["upstream_body"]);
    }
  }
  return redacted;
}
import { isRecord } from "../shared/index.js";
