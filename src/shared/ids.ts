import { randomUUID } from "node:crypto";

export function createRequestId(): string {
  return randomUUID().replaceAll("-", "");
}

export function safeIdentifierPart(value: unknown, fallback = "unknown", limit = 80): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
      ? String(value)
      : "";
  const safe = text
    .trim()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, limit)
    .replaceAll(/-+$/g, "");
  return safe || fallback;
}
