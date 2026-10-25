import type { RecordRow } from "../persistence/index.js";
import { isRecord } from "../shared/index.js";
import { TASK_BRIEF_FACT_VALUE_LIMIT } from "./summary-prompts.js";
import { truncateText } from "./text-limit.js";

/**
 * What the summary model is sent. One boundary turns stored traffic into the text the
 * model reads: the request body is kept to the parts that carry the conversation, long
 * tool payloads are shortened, and a brief adds the few request headers that say which
 * client is talking. Nothing here decides what the model should do with that text -
 * that is `summary-prompts.ts` - and nothing here reads an answer back.
 */

/**
 * The serialized input for one record summary: the request body reduced to the fields
 * that carry the conversation, as JSON text the model can be given as it stands.
 */
export function prepareSummaryInput(request: unknown): string {
  return JSON.stringify(prepareSummaryRequest(request));
}

/**
 * The serialized input for a task brief: the newest complete request plus the client
 * block. A record that was deleted between the two reads is sent as an empty request,
 * which is what the same situation did before this module existed.
 */
export function prepareBriefInput(record: Readonly<RecordRow> | undefined): string {
  return JSON.stringify({
    client: briefClientHints(record?.request_headers),
    request: prepareSummaryRequest(record?.request_body ?? null),
  });
}

/** Request headers that tell which agent or client is driving the task. */
const BRIEF_CLIENT_HEADERS: readonly string[] = [
  "user-agent",
  "x-app",
  "x-app-version",
  "x-agent-task-id",
  "x-session-id",
  "x-claude-code-session-id",
  "x-codex-turn-id",
  "anthropic-version",
];

/**
 * The small "client" block handed to the brief model: only the identifying
 * request headers, so the agent name comes from evidence instead of a guess.
 */
function briefClientHints(headers: unknown): Record<string, string> {
  if (!isRecord(headers)) return {};
  const hints: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!BRIEF_CLIENT_HEADERS.includes(key)) continue;
    const text = headerHintText(value);
    if (text !== undefined) hints[key] = truncateText(text, TASK_BRIEF_FACT_VALUE_LIMIT);
  }
  return hints;
}

function headerHintText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim() !== "") return item.trim();
    }
  }
  return undefined;
}

function prepareSummaryRequest(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const result: Record<string, unknown> = {};
  for (const key of ["model", "messages", "input", "instructions"]) {
    if (request[key] !== undefined)
      result[key] =
        key === "input"
          ? summarizeField("messages", request[key])
          : summarizeField(key, request[key]);
  }
  if (result["messages"] === undefined && result["input"] === undefined) {
    return summarizeValue(request, 0, 4000);
  }
  return result;
}

function summarizeField(key: string, value: unknown): unknown {
  if (key !== "messages" || !Array.isArray(value)) return summarizeValue(value, 0, 6000);
  return value.map((message) => {
    if (!isRecord(message)) return summarizeValue(message, 0, 500);
    const role = typeof message["role"] === "string" ? message["role"] : "unknown";
    const item: Record<string, unknown> = { role };
    // Responses API represents tool interactions as input items rather than
    // chat messages. Keep their identity and linkage intact; only truncate
    // potentially huge arguments/results.
    if (typeof message["type"] === "string") item["type"] = message["type"];
    for (const key of ["id", "call_id", "tool_call_id", "name"] as const) {
      if (message[key] !== undefined) item[key] = message[key];
    }
    for (const key of ["arguments", "output"] as const) {
      if (message[key] !== undefined) item[key] = truncateToolPayload(message[key]);
    }
    if (typeof message["name"] === "string") item["name"] = message["name"];
    if (role === "tool") {
      item["content"] = truncateToolPayload(message["content"]);
    } else if (message["content"] !== undefined) {
      item["content"] = summarizeValue(message["content"], 0, 4000);
    }
    if (Array.isArray(message["tool_calls"])) {
      item["tool_calls"] = message["tool_calls"].map((call) => {
        if (!isRecord(call)) return { type: "tool_call" };
        const fn = isRecord(call["function"]) ? call["function"] : {};
        return {
          id: call["id"],
          type: call["type"] ?? "function",
          function: {
            name: fn["name"] ?? "工具",
            arguments: truncateToolPayload(fn["arguments"]),
          },
        };
      });
    }
    return item;
  });
}

function truncateToolPayload(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value, 2000);
  return summarizeValue(value, 0, 2000);
}

function summarizeValue(value: unknown, depth: number, limit: number): unknown {
  if (typeof value === "string") return truncateText(value, limit);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[内容已省略]";
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => summarizeValue(item, depth + 1, limit));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["image", "image_url", "audio", "file", "data", "bytes"].includes(key)) continue;
    result[key] = summarizeValue(item, depth + 1, limit);
  }
  return result;
}
