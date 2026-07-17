import { isRecord } from "../shared/index.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export interface RequestTransformResult {
  readonly body: Uint8Array;
  readonly strippedFields: readonly string[];
  readonly injectedFields: readonly string[];
}

export function parseStripRequestFields(rawFields: string | null | undefined): Set<string> {
  if (rawFields === null || rawFields === undefined) {
    return new Set();
  }
  return new Set(
    rawFields
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field !== ""),
  );
}

export function parseInjectRequestFields(rawFields: unknown): Record<string, unknown> {
  if (rawFields === null || rawFields === undefined) {
    return {};
  }
  if (isRecord(rawFields)) {
    return { ...rawFields };
  }
  if (typeof rawFields !== "string") {
    throw invalidInjectFields();
  }
  if (rawFields.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFields);
  } catch {
    throw invalidInjectFields();
  }
  if (!isRecord(parsed)) {
    throw invalidInjectFields();
  }
  return parsed;
}

export function transformRequestJsonFields(
  body: Uint8Array,
  stripFields: ReadonlySet<string>,
  injectFields: Readonly<Record<string, unknown>>,
): RequestTransformResult {
  if (body.byteLength === 0 || (stripFields.size === 0 && Object.keys(injectFields).length === 0)) {
    return unchanged(body);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(UTF8_DECODER.decode(body));
  } catch {
    return unchanged(body);
  }
  if (!isRecord(payload)) {
    return unchanged(body);
  }

  const strippedFields = [...stripFields].filter((field) => Object.hasOwn(payload, field));
  for (const field of strippedFields) {
    Reflect.deleteProperty(payload, field);
  }
  const injectedFields = Object.keys(injectFields).sort();
  for (const field of injectedFields) {
    Object.defineProperty(payload, field, {
      configurable: true,
      enumerable: true,
      value: injectFields[field],
      writable: true,
    });
  }
  if (strippedFields.length === 0 && injectedFields.length === 0) {
    return unchanged(body);
  }
  return {
    body: UTF8_ENCODER.encode(JSON.stringify(payload)),
    strippedFields: strippedFields.sort(),
    injectedFields,
  };
}

function unchanged(body: Uint8Array): RequestTransformResult {
  return { body, strippedFields: [], injectedFields: [] };
}

function invalidInjectFields(): TypeError {
  return new TypeError("inject request fields must be a JSON object");
}
