import { isRecord } from "../shared/index.js";

/**
 * Encoding and decoding of the values the traffic tables store.
 *
 * This module changes when a column's stored representation changes — a value
 * that must stay a nano-cent string, a header map that must stay a JSON object
 * of arrays, a timestamp that must also be searchable in local time. It holds no
 * SQL: the access modules hand it the values they are about to write or the cell
 * they have just read, so the representation rule lives in one place instead of
 * being repeated at every statement.
 */

/** Reads a cell as text, or empty when it is not a primitive value. */
export function stringValue(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

/** Stores a cell as text, or null when there is nothing to store. */
export function optionalString(value: unknown): string | null {
  const text = stringValue(value);
  return text === "" ? null : text;
}

/** Reads a stored text cell: null and missing stay null, a value becomes text. */
export function textCell(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

/** Reads a cell as an integer, or null when it is absent or not a whole number. */
export function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = stringValue(value);
  if (text === "") {
    return null;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Reads a money cell as a nano-cent integer, clamped to what SQLite can store. */
export function optionalBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(stringValue(value));
    return parsed >= -9_223_372_036_854_775_808n && parsed <= 9_223_372_036_854_775_807n
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Reads a value as a whole number, falling back to `fallback` when it is not one. */
export function integerValue(value: unknown, fallback: number): number {
  return optionalInteger(value) ?? fallback;
}

/** Reads a cell as a real number, falling back to `fallback`. */
export function floatValue(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const text = stringValue(value);
  if (text === "") {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads a cell as a real number, or null when it is absent or not finite. */
export function optionalFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A stored text column that must never be blank: blank, missing and unparseable
 * all become `fallback`, exactly as the writer treated them.
 */
export function textOr(value: string | undefined | null, fallback: string): string {
  return value === undefined || value === null || value === "" ? fallback : value;
}

/** Serialises a column that always carries a JSON document. */
export function jsonText(value: unknown, fallback: unknown): string {
  return JSON.stringify(value ?? fallback);
}

/** Serialises a column that is allowed to stay empty. */
export function optionalJsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : jsonText(value, null);
}

/** Parses a stored JSON document, falling back when the cell is empty or corrupt. */
export function jsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(stringValue(value)) as unknown;
  } catch {
    return structuredClone(fallback);
  }
}

/** A stored JSON document that may be anything the writer put in it. */
export function storedJsonValue(value: unknown): unknown {
  return jsonValue(value, null);
}

/**
 * A stored JSON object column. A cell that holds something other than an object —
 * an empty column, a damaged import — reads back as `fallback`, so a reader always
 * gets a mapping it can index.
 */
export function storedJsonObject(
  value: unknown,
  fallback: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const parsed = jsonValue(value, fallback);
  return isRecord(parsed) ? parsed : structuredClone(fallback);
}

/**
 * A stored JSON array column. A cell that holds something other than an array reads
 * back as `fallback`, so a reader always gets a list it can iterate.
 */
export function storedJsonArray(
  value: unknown,
  fallback: readonly unknown[] = [],
): readonly unknown[] {
  const parsed = jsonValue(value, fallback);
  return Array.isArray(parsed) ? parsed : structuredClone(fallback);
}

/** The pricing block of a write or a row, or empty when it was never filled. */
export function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/** One of the three pricing states, with anything unrecognised read as unpriced. */
export function pricingStatus(value: unknown): PricingState {
  return value === "pending" || value === "priced" || value === "unpriced" ? value : "unpriced";
}

/** The pricing states a record row can carry. */
export type PricingState = "pending" | "priced" | "unpriced";

/**
 * Parse an ISO-8601 local timestamp (with or without milliseconds/offset) as
 * epoch milliseconds; null when unparseable. `new Date` handles both forms.
 */
export function recordTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
