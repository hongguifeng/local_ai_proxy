import type { BytePayload } from "./protocol/payload.js";
import type { ResponseLogPayload, TruncatedResponseLogPayload } from "./response-log-capture.js";
import type { TrafficHeaderMap, TrafficRecordEvent, TrafficRequestInfo } from "./traffic-event.js";

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

export function redactHeaders(headers: TrafficHeaderMap): TrafficHeaderMap {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
        return [name, [...value]];
      }
      return [name, value.map(() => REDACTED)];
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

/**
 * Rewrite a stored body so its JSON credentials are gone. A truncated body keeps its own
 * shape because it carries no base64 to clear.
 */
export function redactBody(body: BytePayload): BytePayload;
export function redactBody(body: TruncatedResponseLogPayload): TruncatedResponseLogPayload;
export function redactBody(body: ResponseLogPayload): ResponseLogPayload;
export function redactBody(body: ResponseLogPayload): ResponseLogPayload {
  const text = body.text;
  if (text === "") {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return body;
  }
  const redactedText = JSON.stringify(redactJsonValue(parsed));
  return "base64" in body
    ? {
        ...body,
        text: redactedText,
        base64: "",
        size_bytes: Buffer.byteLength(redactedText, "utf8"),
      }
    : { ...body, text: redactedText, size_bytes: Buffer.byteLength(redactedText, "utf8") };
}

/**
 * A copy of a lifecycle event with credentials removed from headers and bodies. The copy
 * is deep so a later edit of the stored form never reaches the bytes still being forwarded.
 */
export function redactEvent(record: TrafficRecordEvent): TrafficRecordEvent {
  const copy = structuredClone(record);
  const request = redactRequestBlock(copy.request);
  switch (copy.event) {
    case "request_received":
      return { ...copy, request };
    case "request_pending_response":
      return { ...copy, request };
    case "request_finished":
      return {
        ...copy,
        request,
        response: {
          ...copy.response,
          headers: redactHeaders(copy.response.headers),
          body: redactBody(copy.response.body),
        },
      };
  }
}

function redactRequestBlock(request: TrafficRequestInfo): TrafficRequestInfo {
  return {
    ...request,
    headers: redactHeaders(request.headers),
    body: redactBody(request.body),
    ...(request.upstream_body === undefined
      ? {}
      : { upstream_body: redactBody(request.upstream_body) }),
  };
}
