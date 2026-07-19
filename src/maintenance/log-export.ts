import { ZipArchive } from "archiver";
import type { Readable } from "node:stream";

import { TrafficRepository, type RepositoryRecord } from "../persistence/index.js";
import { formatLocalTimestamp, safeIdentifierPart } from "../shared/index.js";

export interface LogExportEntry {
  readonly name: "request.json" | "response.json";
  readonly text: string;
}

export function createLogExportStream(logRoots: readonly string[]): Readable {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  queueMicrotask(() => {
    try {
      for (const root of [...new Set(logRoots.filter((value) => value !== ""))]) {
        const repository = new TrafficRepository(root);
        try {
          for (const task of allTasks(repository)) {
            const taskDirectory = taskExportDirectory(task);
            const records = allRecords(repository, text(task["id"]));
            const base = `tasks/${taskDirectory}`;
            archive.append(renderTaskIndexMarkdown(task, records), { name: `${base}/index.md` });
            for (const record of records) {
              const recordBase = `${base}/${recordExportDirectory(record)}`;
              archive.append(renderRecordSummaryMarkdown(task, record), {
                name: `${recordBase}/summary.md`,
              });
              for (const entry of recordJsonEntries(record)) {
                archive.append(entry.text, { name: `${recordBase}/${entry.name}` });
              }
            }
          }
        } finally {
          repository.close();
        }
      }
      void archive.finalize();
    } catch (error) {
      archive.emit("error", error instanceof Error ? error : new Error("Log export failed."));
    }
  });
  return archive;
}

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

export function renderRecordSummaryMarkdown(
  task: Readonly<RepositoryRecord>,
  record: Readonly<RepositoryRecord>,
): string {
  const lines = [
    `# LLM Interaction ${text(record["id"])}`,
    "",
    "## Summary",
    "",
    `- Time: ${displayTimestamp(record["timestamp"])}`,
    `- Event: ${text(record["event"])}`,
    `- Duration: ${text(record["duration_ms"])} ms`,
    `- Target: ${text(record["target_url"])}`,
    `- Request: ${text(record["method"])} ${text(record["path"])}`,
    `- Endpoint: ${text(record["endpoint"])}`,
    `- Message count: ${text(record["message_count"])}`,
    `- Token count: ${text(record["token_count"])}`,
    `- Response: ${text(record["status"])}`,
  ];
  if (text(record["error"]) !== "") {
    lines.push(`- Error: ${text(record["error"])}`);
  }
  lines.push(
    `- Task: ${text(task["kind"])} / ${text(task["id"])} / request ${text(record["sequence"])}`,
    "",
    "## Request Body",
    "",
    "See `request.json`.",
    "",
    "## Response Body",
    "",
    "See `response.json`.",
    "",
  );
  return lines.join("\n");
}

export function recordJsonEntries(record: Readonly<RepositoryRecord>): readonly LogExportEntry[] {
  return [
    { name: "request.json", text: prettyJson(record["request_body"] ?? null) },
    { name: "response.json", text: prettyJson(record["response_body"] ?? null) },
  ];
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

function prettyJson(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

function allTasks(repository: TrafficRepository): RepositoryRecord[] {
  const tasks: RepositoryRecord[] = [];
  let page = repository.listTasks("", 500, 0);
  tasks.push(...page.items);
  while (page.hasMore) {
    page = repository.listTasks("", 500, page.nextOffset);
    tasks.push(...page.items);
  }
  return tasks;
}

function allRecords(repository: TrafficRepository, taskId: string): RepositoryRecord[] {
  const records: RepositoryRecord[] = [];
  let page = repository.listTaskRecords(taskId, "", 500, 0);
  records.push(...page.items);
  while (page.hasMore) {
    page = repository.listTaskRecords(taskId, "", 500, page.nextOffset);
    records.push(...page.items);
  }
  return records;
}
