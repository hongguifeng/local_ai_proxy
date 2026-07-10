export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type RequestJsonParseState = "object" | "invalid-utf8" | "invalid-json" | "non-object";

export type ParsedRequestBody = Readonly<{
  state: RequestJsonParseState;
  value: Record<string, unknown> | null;
}>;

export type RequestBodyTransform = Readonly<{
  body: Uint8Array;
  strippedFields: readonly string[];
  injectedFields: readonly string[];
  bodyChanged: boolean;
}>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export function parseRequestJsonObject(body: Uint8Array): ParsedRequestBody {
  let text: string;
  try {
    text = UTF8_DECODER.decode(body);
  } catch {
    return { state: "invalid-utf8", value: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { state: "invalid-json", value: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "non-object", value: null };
  }
  return { state: "object", value: parsed as Record<string, unknown> };
}

export function requestModelFromParsedBody(parsed: ParsedRequestBody): string | null {
  const model = parsed.value?.model;
  return typeof model === "string" ? model : null;
}

export function transformParsedRequestBody(
  originalBody: Uint8Array,
  parsed: ParsedRequestBody,
  stripFields: readonly string[],
  injectFields: Readonly<Record<string, JsonValue>>,
  upstreamModel: string | null,
): RequestBodyTransform {
  if (parsed.value === null) {
    return unchanged(originalBody);
  }
  const payload = parsed.value;

  const strippedFields = [...new Set(stripFields.filter((field) => Object.hasOwn(payload, field)))].sort();
  const injectedFields = Object.keys(injectFields).sort();
  const rewriteModel = upstreamModel !== null && payload.model !== upstreamModel;
  if (strippedFields.length === 0 && injectedFields.length === 0 && !rewriteModel) {
    return unchanged(originalBody);
  }

  for (const field of strippedFields) {
    Reflect.deleteProperty(payload, field);
  }
  for (const field of injectedFields) {
    defineJsonField(payload, field, injectFields[field] as JsonValue);
  }
  if (upstreamModel !== null) {
    defineJsonField(payload, "model", upstreamModel);
  }

  return {
    body: UTF8_ENCODER.encode(JSON.stringify(payload)),
    strippedFields,
    injectedFields,
    bodyChanged: true,
  };
}

function defineJsonField(target: Record<string, unknown>, field: string, value: JsonValue): void {
  Object.defineProperty(target, field, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function unchanged(body: Uint8Array): RequestBodyTransform {
  return { body, strippedFields: [], injectedFields: [], bodyChanged: false };
}
