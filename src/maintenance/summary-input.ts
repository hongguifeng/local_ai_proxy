import type { RecordRow } from "../persistence/index.js";
import { endpointKind, type EndpointKind } from "../proxy/protocol/analysis.js";
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

/**
 * The compression rule every stored payload goes through before the model reads it: long
 * strings are cut with an explicit ellipsis, deep nesting is replaced by a named marker,
 * arrays are bounded, and the media fields a text model cannot read are dropped. `dropped`
 * is told every time one of the four happens, which is how the timeline knows it is
 * showing a compressed view instead of the whole log.
 */
function summarizeValue(
  value: unknown,
  depth: number,
  limit: number,
  dropped?: (reason: "length" | "depth" | "array" | "media") => void,
): unknown {
  if (typeof value === "string") {
    if (value.length > limit) dropped?.("length");
    return truncateText(value, limit);
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) {
    dropped?.("depth");
    return "[内容已省略]";
  }
  if (Array.isArray(value)) {
    if (value.length > 30) dropped?.("array");
    return value.slice(0, 30).map((item) => summarizeValue(item, depth + 1, limit, dropped));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (MEDIA_FIELDS.includes(key)) {
      dropped?.("media");
      continue;
    }
    result[key] = summarizeValue(item, depth + 1, limit, dropped);
  }
  return result;
}

const MEDIA_FIELDS: readonly string[] = ["image", "image_url", "audio", "file", "data", "bytes"];

// ------------------------------------------------------------------ task execution timeline

/**
 * The event vocabulary the timeline is built from. `event_no` is assigned by this module
 * in the input's own array order, so the model never decides what came first; `kind` is
 * the normalized reading of the protocol field. `truncation_marker` is not a log event:
 * it is this module saying "what you did not read is not the same as what did not happen".
 */
export type TimelineEventKind =
  | "user_message"
  | "assistant_message"
  | "system_message"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result"
  | "other"
  | "truncation_marker";

/** One numbered piece of evidence the summary model may cite. */
export interface TimelineEvent {
  readonly event_no: number;
  readonly kind: TimelineEventKind;
  readonly role?: string | undefined;
  readonly text?: string | undefined;
  readonly tool?: string | undefined;
  readonly arguments_preview?: string | undefined;
  readonly result_preview?: string | undefined;
  readonly call_id?: string | undefined;
  readonly operation_id?: string | undefined;
  readonly call_event_no?: number | undefined;
  readonly result_event_no?: number | undefined;
  readonly unpaired?: boolean | undefined;
}

/** What the events were taken from, so the console can say how big the source was. */
export interface TimelineSource {
  readonly request_sequence: number;
  readonly api_kind: EndpointKind;
  readonly event_count: number;
  readonly truncated: boolean;
}

/** The whole brief input: the numbered events plus the client block the facts come from. */
export interface TaskTimelineInput {
  readonly source: TimelineSource;
  readonly client: Readonly<Record<string, string>>;
  readonly events: readonly TimelineEvent[];
}

/**
 * A Chat message's published reasoning summary, and nothing else. The wire also carries
 * the model's private thinking under `reasoning_content`, `reasoning_text` and `thinking`,
 * and a Responses reasoning item carries unreadable thinking under `encrypted_content`;
 * none of those are ever turned into an event, because this feature shows only the thinking
 * the log publishes and must never claim to know the rest.
 */

/** The text limit a message or reasoning summary keeps inside the input. */
const TIMELINE_TEXT_LIMIT = 4000;

/** The text limit a tool argument or tool result keeps inside the input. */
const TIMELINE_PREVIEW_LIMIT = 2000;

/** A mutable event while the array is still being built and numbered. */
interface TimelineDraft {
  kind: TimelineEventKind;
  role?: string | undefined;
  text?: string | undefined;
  tool?: string | undefined;
  arguments_preview?: string | undefined;
  result_preview?: string | undefined;
  call_id?: string | undefined;
  operation_id?: string | undefined;
  call_event_no?: number | undefined;
  result_event_no?: number | undefined;
  unpaired?: boolean | undefined;
}

/** A numbered event whose call/result link is still being written. */
interface NumberedEvent extends TimelineDraft {
  event_no: number;
}

/** Counts what the compression cut away, so the input can declare itself truncated. */
interface CompressionReport {
  truncated: boolean;
}

/**
 * The task-timeline input: one stored record turned into numbered evidence events.
 *
 * The whole point is that the server, not the model, fixes the order and the call/result
 * relationship. Responses `input` items and Chat `messages` are walked in array order, so
 * `event_no` is the position the log actually has; a call and its result keep their own
 * numbers and gain `call_id`, `operation_id` and the forward/backward link, so a parallel
 * batch of calls stays a batch instead of becoming a made-up sequence. Nothing here reads
 * the database or the model's answer.
 *
 * A record that was deleted between the two reads yields no events at all, which is the
 * same empty request the old brief input sent; the answer parser then refuses any citation.
 */
export function prepareTaskTimelineInput(
  record: Readonly<RecordRow> | undefined,
): TaskTimelineInput {
  const report: CompressionReport = { truncated: false };
  const body = record?.request_body ?? null;
  const drafts: TimelineDraft[] = [];

  const instructions = isRecord(body) ? body["instructions"] : undefined;
  if (instructions !== undefined && instructions !== null && instructions !== "") {
    drafts.push({
      kind: "system_message",
      role: "system",
      text: eventText(instructions, report),
    });
  }
  // The Anthropic wire shape carries the top-level system prompt as `system`; the
  // Completions shape carries it as a string too. Both are evidence the agent's own
  // environment facts (working directory, branch, OS) usually come from.
  const system = isRecord(body) ? body["system"] : undefined;
  if (system !== undefined && system !== null && system !== "") {
    drafts.push({ kind: "system_message", role: "system", text: eventText(system, report) });
  }

  const history = isRecord(body) ? (body["messages"] ?? body["input"]) : undefined;
  if (typeof history === "string") {
    drafts.push({ kind: "user_message", role: "user", text: cutText(history, report) });
  } else if (Array.isArray(history)) {
    for (const item of history) pushHistoryItem(item, drafts, report);
  } else if (isRecord(body)) {
    // A request with no conversation at all: the model is given the compressed body as
    // one event rather than nothing, because "there is nothing here" is itself evidence.
    drafts.push({ kind: "other", text: previewValue(body, report) });
  } else if (record !== undefined) {
    // The request body was never stored, or was stored as nothing. The model is told so in
    // one numbered event, so an honest answer can cite it instead of inventing a step.
    drafts.push({ kind: "other", text: "[这条请求没有留下可读的请求体]" });
  }

  const events = numberAndPair(drafts);
  if (report.truncated) {
    events.push({
      event_no: events.length + 1,
      kind: "truncation_marker",
      text:
        "上面的部分事件被压缩过：超过长度上限的正文以 … 结尾，三层以上的嵌套对象写成 [内容已省略]，" +
        "图片、音频和文件字段没有送进来。没有读到不等于没有发生。",
    });
  }

  return {
    source: {
      request_sequence: record?.sequence ?? 0,
      api_kind: record === undefined ? "other" : endpointKind(record.path),
      event_count: events.length,
      truncated: report.truncated,
    },
    client: briefClientHints(record?.request_headers),
    events,
  };
}

/** Turn drafts into numbered events and link every result back to the call it answers. */
function numberAndPair(drafts: readonly TimelineDraft[]): TimelineEvent[] {
  const events: NumberedEvent[] = drafts.map((draft, index) => ({
    // `event_no` is written first so the number is the first thing the model reads.
    event_no: index + 1,
    ...draft,
  }));
  const waitingCalls = new Map<string, NumberedEvent[]>();
  for (const event of events) {
    if (event.kind !== "tool_call" || event.call_id === undefined) continue;
    const outstanding = waitingCalls.get(event.call_id);
    if (outstanding === undefined) waitingCalls.set(event.call_id, [event]);
    else outstanding.push(event);
  }
  for (const event of events) {
    if (event.kind !== "tool_result" || event.call_id === undefined) continue;
    const outstanding = waitingCalls.get(event.call_id);
    const call = outstanding?.shift();
    if (call === undefined) {
      // A result whose call is not in this request. The number stays, the relationship
      // does not get invented, and the console can see it is unpaired.
      event.unpaired = true;
      continue;
    }
    const operationId = `op-${call.event_no}`;
    call.operation_id = operationId;
    call.result_event_no = event.event_no;
    event.operation_id = operationId;
    event.call_event_no = call.event_no;
  }
  return events;
}

/** One `messages` / `input` array item turned into zero or more evidence events. */
function pushHistoryItem(item: unknown, drafts: TimelineDraft[], report: CompressionReport): void {
  if (!isRecord(item)) {
    drafts.push({ kind: "other", text: cutText(textOf(item), report) });
    return;
  }
  // Chat items are named by `role`; Responses input items are named by `type`. A payload
  // that mixes both is read by whichever name the item actually carries.
  if (typeof item["role"] === "string") {
    pushChatMessage(item, item["role"], drafts, report);
    return;
  }
  if (typeof item["type"] === "string") {
    pushResponsesItem(item, item["type"], drafts, report);
    return;
  }
  drafts.push({ kind: "other", text: previewValue(item, report) });
}

/** A Chat Completions message. */
function pushChatMessage(
  message: Record<string, unknown>,
  role: string,
  drafts: TimelineDraft[],
  report: CompressionReport,
): void {
  const content = message["content"];
  const text = eventText(content, report);
  if (role === "tool" || role === "function") {
    const callId = identifier(message["tool_call_id"] ?? message["id"]);
    drafts.push({
      kind: "tool_result",
      result_preview: toolPreview(content, report),
      ...(callId === undefined ? {} : { call_id: callId }),
    });
    return;
  }
  const calls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
  if (text !== "" || calls.length === 0) {
    drafts.push({ kind: chatKind(role), role, ...(text === "" ? {} : { text }) });
  }
  for (const call of calls) {
    const draft = chatToolCall(call, report);
    if (draft !== undefined) drafts.push(draft);
  }
  // A Chat message may also carry a published reasoning summary. Only that is read; the
  // raw thinking fields are never turned into an event.
  const summary = reasoningSummaryText(message, report);
  if (summary !== undefined && summary !== "") {
    drafts.push({ kind: "reasoning_summary", role, text: summary });
  }
}

function chatKind(role: string): TimelineEventKind {
  if (role === "user") return "user_message";
  if (role === "assistant") return "assistant_message";
  if (role === "system" || role === "developer") return "system_message";
  return "other";
}

function chatToolCall(call: unknown, report: CompressionReport): TimelineDraft | undefined {
  if (!isRecord(call)) return undefined;
  const fn = isRecord(call["function"]) ? call["function"] : {};
  const callId = identifier(call["id"]);
  return {
    kind: "tool_call",
    ...(typeof fn["name"] === "string" && fn["name"] !== "" ? { tool: fn["name"] } : {}),
    ...(typeof fn["arguments"] === "string" || fn["arguments"] !== undefined
      ? { arguments_preview: toolPreview(fn["arguments"], report) }
      : {}),
    ...(callId === undefined ? {} : { call_id: callId }),
  };
}

/** A Responses API input item. */
function pushResponsesItem(
  item: Record<string, unknown>,
  type: string,
  drafts: TimelineDraft[],
  report: CompressionReport,
): void {
  const callId = identifier(item["call_id"]);
  if (type === "function_call") {
    drafts.push({
      kind: "tool_call",
      ...(typeof item["name"] === "string" && item["name"] !== "" ? { tool: item["name"] } : {}),
      ...(item["arguments"] === undefined
        ? {}
        : { arguments_preview: toolPreview(item["arguments"], report) }),
      ...(callId === undefined ? {} : { call_id: callId }),
    });
    return;
  }
  if (type === "function_call_output" || type === "function_call_response") {
    drafts.push({
      kind: "tool_result",
      result_preview: toolPreview(item["output"] ?? item["result"] ?? item["content"], report),
      ...(callId === undefined ? {} : { call_id: callId }),
    });
    return;
  }
  if (type === "reasoning") {
    const summary = visibleReasoningSummary(item, report);
    if (summary === undefined) {
      // A reasoning item with no published summary: the thinking is not readable here,
      // so the event says that instead of carrying hidden content.
      drafts.push({ kind: "other", text: "[思考内容没有公开摘要]" });
      return;
    }
    drafts.push({ kind: "reasoning_summary", text: summary });
    return;
  }
  if (type === "message" || type === "output_message" || type === "input_item") {
    const role = typeof item["role"] === "string" ? item["role"] : "unknown";
    drafts.push({
      kind: chatKind(role),
      role,
      text: eventText(item["content"], report),
    });
    return;
  }
  if (type === "item_reference" || type === "item") {
    drafts.push({ kind: "other", text: "[引用了另一个输入项]" });
    return;
  }
  // Anything else an agent input may hold - a file, an image, a custom item. Its type is
  // kept so the reader knows what kind of thing sat at this position.
  const role = typeof item["role"] === "string" ? item["role"] : undefined;
  drafts.push({
    kind: "other",
    ...(role === undefined ? {} : { role }),
    text: previewValue(item, report),
  });
}

/** The published or plaintext-visible summary of a Responses reasoning item, or nothing when there is none. */
function visibleReasoningSummary(
  item: Record<string, unknown>,
  report: CompressionReport,
): string | undefined {
  const summary = item["summary"];
  if (typeof summary === "string") return cutText(summary, report);
  if (Array.isArray(summary)) {
    const parts: string[] = [];
    for (const part of summary) {
      if (typeof part === "string") parts.push(cutText(part, report));
      else if (isRecord(part) && typeof part["text"] === "string")
        parts.push(cutText(part["text"], report));
    }
    if (parts.length > 0) return parts.join("\n");
  }
  // Some Responses records publish plaintext reasoning in `content` while leaving the
  // optional `summary` array empty. It is still visible evidence in the stored request,
  // so keep it; only the opaque encrypted field below remains excluded.
  if (Array.isArray(item["content"])) {
    const parts: string[] = [];
    for (const part of item["content"]) {
      if (isRecord(part) && part["type"] === "reasoning_text" && typeof part["text"] === "string")
        parts.push(cutText(part["text"], report));
    }
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  return undefined;
}

/** The published reasoning summary a Chat message may carry, or nothing. */
function reasoningSummaryText(
  message: Record<string, unknown>,
  report: CompressionReport,
): string | undefined {
  // Only `reasoning_summary` is read. The thinking fields the wire also carries
  // (`reasoning_content`, `reasoning_text`, `thinking`) are never turned into an event:
  // they are the model's private chain of thought, and this feature shows only what the
  // log publishes about the thinking.
  const published = message["reasoning_summary"];
  if (typeof published === "string") return cutText(published, report);
  if (Array.isArray(published)) {
    const parts: string[] = [];
    for (const part of published) {
      if (typeof part === "string") parts.push(cutText(part, report));
      else if (isRecord(part) && typeof part["text"] === "string")
        parts.push(cutText(part["text"], report));
    }
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  return undefined;
}

/** The string an event carries, with the media fields dropped and the length limit applied. */
function eventText(content: unknown, report: CompressionReport): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return cutText(content, report);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(cutText(part, report));
        continue;
      }
      if (!isRecord(part)) continue;
      if (typeof part["text"] === "string") {
        parts.push(cutText(part["text"], report));
        continue;
      }
      if (MEDIA_FIELDS.some((field) => part[field] !== undefined)) report.truncated = true;
    }
    return parts.join("\n");
  }
  return previewValue(content, report);
}

/** A tool argument or tool result: shortened, then serialized to text. */
function toolPreview(value: unknown, report: CompressionReport): string {
  if (typeof value === "string") return cutText(value, report, TIMELINE_PREVIEW_LIMIT);
  return previewValue(value, report, TIMELINE_PREVIEW_LIMIT);
}

/** A value no message text can be read out of: kept as a short, compressed JSON preview. */
function previewValue(
  value: unknown,
  report: CompressionReport,
  limit = TIMELINE_TEXT_LIMIT,
): string {
  const dropped = (reason: "length" | "depth" | "array" | "media"): void => {
    void reason;
    report.truncated = true;
  };
  return truncateText(textOf(summarizeValue(value, 0, limit, dropped)), limit + 1);
}

function cutText(value: string, report: CompressionReport, limit = TIMELINE_TEXT_LIMIT): string {
  if (value.length > limit) report.truncated = true;
  return truncateText(value, limit);
}

/** The text form of a value that has no message text of its own. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  // `JSON.stringify` yields nothing for `undefined`, which would otherwise turn a missing
  // value into the word "undefined" inside an event.
  if (value === undefined) return "[没有这个值]";
  try {
    return JSON.stringify(value);
  } catch {
    return "[无法序列化的内容]";
  }
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
