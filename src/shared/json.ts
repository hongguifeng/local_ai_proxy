export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = parseJson(text);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftCodePoints[index]?.codePointAt(0) ?? 0) - (rightCodePoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}
