import { isRecord } from "../shared/index.js";

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

function invalidInjectFields(): TypeError {
  return new TypeError("inject request fields must be a JSON object");
}
