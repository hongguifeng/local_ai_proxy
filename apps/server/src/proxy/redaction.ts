export type SanitizedJsonValue =
  null | boolean | number | string | SanitizedJsonValue[] | { [key: string]: SanitizedJsonValue };

export const REDACTED_VALUE = "[redacted]";
export const TRUNCATED_VALUE = "[truncated]";
export const CIRCULAR_VALUE = "[circular]";

export type JsonSanitizationLimits = Readonly<{
  maxDepth: number;
  maxItems: number;
  maxStringBytes: number;
}>;

export const DEFAULT_JSON_SANITIZATION_LIMITS: JsonSanitizationLimits = Object.freeze({
  maxDepth: 32,
  maxItems: 10_000,
  maxStringBytes: 256 * 1024,
});

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"]);
const SENSITIVE_JSON_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "access_token",
  "refresh_token",
  "token",
  "password",
  "secret",
]);
const UTF8_ENCODER = new TextEncoder();
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export function redactHeaders(headers: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const redacted: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [name, values] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? values.map(() => REDACTED_VALUE) : [...values];
  }
  return redacted;
}

export function sanitizeJsonValue(
  value: unknown,
  limits: JsonSanitizationLimits = DEFAULT_JSON_SANITIZATION_LIMITS,
): SanitizedJsonValue {
  assertLimits(limits);
  const state = { remainingItems: limits.maxItems, ancestors: new WeakSet<object>() };
  return sanitizeValue(value, 0, limits, state);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  limits: JsonSanitizationLimits,
  state: { remainingItems: number; ancestors: WeakSet<object> },
): SanitizedJsonValue {
  if (state.remainingItems === 0 || depth > limits.maxDepth) {
    return TRUNCATED_VALUE;
  }
  state.remainingItems -= 1;

  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateUtf8(value, limits.maxStringBytes);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "object") {
    return null;
  }
  if (state.ancestors.has(value)) {
    return CIRCULAR_VALUE;
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: SanitizedJsonValue[] = [];
      for (const item of value) {
        if (state.remainingItems === 0) {
          result.push(TRUNCATED_VALUE);
          break;
        }
        result.push(sanitizeValue(item, depth + 1, limits, state));
      }
      return result;
    }

    const result: Record<string, SanitizedJsonValue> = Object.create(null) as Record<string, SanitizedJsonValue>;
    for (const [key, item] of Object.entries(value)) {
      if (state.remainingItems === 0) {
        defineJsonField(result, "[truncated]", true);
        break;
      }
      if (SENSITIVE_JSON_KEYS.has(key.toLowerCase())) {
        state.remainingItems -= 1;
        defineJsonField(result, key, REDACTED_VALUE);
        continue;
      }
      defineJsonField(result, key, sanitizeValue(item, depth + 1, limits, state));
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0) {
    try {
      return UTF8_FATAL_DECODER.decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function defineJsonField(target: Record<string, SanitizedJsonValue>, key: string, value: SanitizedJsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function assertLimits(limits: JsonSanitizationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}
