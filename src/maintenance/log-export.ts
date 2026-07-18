import type { RepositoryRecord } from "../persistence/index.js";
import { formatLocalTimestamp, safeIdentifierPart } from "../shared/index.js";

export function taskExportDirectory(task: Readonly<RepositoryRecord>): string {
  const timestamp = compactTimestamp(task["started_at"]) || "unknown-time";
  const model = safeIdentifierPart(task["model"], "unknown-model", 32);
  const kind = safeIdentifierPart(task["kind"], "task", 24);
  const taskId = safeIdentifierPart(task["id"], "task", 16);
  return `${timestamp}__${model}__${kind}__${taskId}`;
}

export function recordExportDirectory(record: Readonly<RepositoryRecord>): string {
  const sequence = integer(record["sequence"]);
  const endpoint = safeIdentifierPart(record["endpoint"], "request", 40);
  const recordId = safeIdentifierPart(record["id"], "record", 24);
  return `${String(sequence).padStart(3, "0")}__${endpoint}__${recordId}`;
}

function compactTimestamp(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  try {
    return formatLocalTimestamp(value).replace(" ", "__").replaceAll(":", "-");
  } catch {
    return safeIdentifierPart(value, "time", 32);
  }
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}
