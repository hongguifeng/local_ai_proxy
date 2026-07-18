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

export function renderTaskIndexMarkdown(
  task: Readonly<RepositoryRecord>,
  records: readonly Readonly<RepositoryRecord>[],
): string {
  const lines = [
    `# LLM Task ${text(task["id"])}`,
    "",
    "## Summary",
    "",
    `- Kind: ${text(task["kind"])}`,
    `- Started: ${displayTimestamp(task["started_at"])}`,
    `- Last seen: ${displayTimestamp(task["last_seen_at"])}`,
    `- Last response: ${displayTimestamp(task["last_response_at"])}`,
    `- Requests: ${integer(task["request_count"] ?? records.length)}`,
  ];
  if (text(task["model"]) !== "") {
    lines.push(`- Model: ${text(task["model"])}`);
  }
  if (text(task["target"]) !== "") {
    lines.push(`- Target: ${text(task["target"])}`);
  }
  lines.push("", "## Timeline", "");
  for (const record of [...records].sort(
    (left, right) => integer(left["sequence"]) - integer(right["sequence"]),
  )) {
    const sequence = integer(record["sequence"]);
    const status =
      record["status"] === null || record["status"] === undefined
        ? "pending"
        : text(record["status"]);
    lines.push(
      `- ${String(sequence).padStart(3, "0")} \`${text(record["method"])} ${text(record["path"])}\` -> ${status} (${text(record["duration_ms"])} ms) [${text(record["id"])}](${recordExportDirectory(record)}/)`,
    );
  }
  lines.push("");
  return lines.join("\n");
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

function displayTimestamp(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  try {
    return formatLocalTimestamp(value);
  } catch {
    return value;
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "";
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}
