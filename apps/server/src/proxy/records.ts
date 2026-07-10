import { createHash } from "node:crypto";

import { sanitizeJsonValue, type SanitizedJsonValue } from "./redaction.js";

export type EndpointKind = "responses" | "messages" | "chat" | "completions" | "other";

export type RecordPayloadSummary = Readonly<{
  kind: EndpointKind;
  endpoint: string;
  messageCount: number | null;
  tokenCount: number | null;
  previousResponseId: string | null;
  responseIds: readonly string[];
  contextKeys: readonly string[];
  fingerprints: Readonly<Record<string, string>>;
  boundaryFingerprints: Readonly<Record<string, string>>;
  userMessages: readonly SanitizedJsonValue[];
}>;

export type RequestIdentifierContext = Readonly<{
  promptCacheKey?: unknown;
  clientThreadId?: unknown;
  clientSessionId?: unknown;
}>;

const MAX_TRAVERSED_ITEMS = 1_000;
const MAX_FINGERPRINT_DEPTH = 16;
const MAX_FINGERPRINT_STRING_BYTES = 64 * 1024;
const CONTEXT_PREFIXES = [
  "<environment_context>",
  "<permissions instructions>",
  "<app-context>",
  "# Codex desktop context",
] as const;

export function endpointKind(path: string): EndpointKind {
  const normalized = path.toLowerCase().split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  if (normalized.endsWith("/responses")) return "responses";
  if (normalized.endsWith("/messages")) return "messages";
  if (normalized.endsWith("/chat/completions")) return "chat";
  if (normalized.endsWith("/completions")) return "completions";
  return "other";
}

export function displayEndpoint(path: unknown): string {
  if (typeof path !== "string") return "/";
  const normalized = path.split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  return normalized || "/";
}

export function requestMessageCount(kind: EndpointKind, payload: unknown): number | null {
  const object = asObject(payload);
  if (!object) return null;
  if (kind === "responses") {
    const input = object.input;
    const inputCount = Array.isArray(input) ? input.length : input === null || input === undefined ? 0 : 1;
    return inputCount + (object.instructions ? 1 : 0);
  }
  if (kind === "messages") {
    const system = object.system;
    const systemCount = Array.isArray(system) ? system.length : system ? 1 : 0;
    return systemCount + (Array.isArray(object.messages) ? object.messages.length : 0);
  }
  if (kind === "chat") return Array.isArray(object.messages) ? object.messages.length : 0;
  if (kind === "completions") {
    if (Array.isArray(object.prompt)) return object.prompt.length;
    return object.prompt === null || object.prompt === undefined ? 0 : 1;
  }
  if (Array.isArray(object.messages)) return object.messages.length;
  if (Array.isArray(object.input)) return object.input.length;
  return object.input === null || object.input === undefined ? null : 1;
}

export function responseTokenCount(payload: unknown): number | null {
  const object = asObject(payload);
  if (!object) return null;
  const streamSummary = asObject(object.stream_summary);
  const response = asObject(object.response);
  const usage = asObject(streamSummary?.usage) ?? asObject(object.usage) ?? asObject(response?.usage);
  if (!usage) return null;
  const total = nonNegativeInteger(usage.total_tokens);
  if (total !== null) return total;
  const parts = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => nonNegativeInteger(usage[key]))
    .filter((value): value is number => value !== null);
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null;
}

export function responseIdsFromBody(payload: unknown): string[] {
  const object = asObject(payload);
  if (!object) return [];
  const nested = asObject(object.response);
  return uniqueStrings([object.id, nested?.id]);
}

export function requestIdentifiers(
  payload: unknown,
  context: RequestIdentifierContext = {},
): Readonly<{
  previousResponseId: string | null;
  contextKeys: readonly string[];
}> {
  const object = boundedObject(payload);
  if (!object) return { previousResponseId: null, contextKeys: [] };
  const metadata = asObject(object.metadata);
  const conversation = asObject(object.conversation);
  const conversationId = firstString(
    object.conversation,
    conversation?.id,
    object.conversation_id,
    object.thread_id,
    metadata?.conversation_id,
    metadata?.thread_id,
    metadata?.session_id,
  );
  const contextKeys = uniqueStrings([
    conversationId ? `conversation:${conversationId}` : null,
    prefixString("prompt_cache", object.prompt_cache_key),
    prefixString("prompt_cache", context.promptCacheKey),
    prefixString("client_thread", context.clientThreadId),
    prefixString("client_session", context.clientSessionId),
  ]);
  return {
    previousResponseId: firstString(object.previous_response_id),
    contextKeys,
  };
}

export function requestUserMessages(kind: EndpointKind, payload: unknown): SanitizedJsonValue[] {
  const object = boundedObject(payload);
  if (!object) return [];
  if (kind === "completions") {
    return object.prompt ? [boundedJson(object.prompt)] : [];
  }

  const source = kind === "responses" ? responseInputItems(object) : boundedArray(object.messages);
  const result: SanitizedJsonValue[] = [];
  for (const item of source) {
    const message = asObject(item);
    if (message?.role !== "user" || isTaskContextMessage(message)) continue;
    if (kind === "responses") {
      result.push(responseItemSummary(message));
    } else {
      result.push(
        compactObject({
          role: message.role,
          content: boundedJson(message.content),
          name: message.name,
          ...(kind === "messages" ? { tool_use_id: message.tool_use_id } : {}),
        }),
      );
    }
    if (result.length >= MAX_TRAVERSED_ITEMS) break;
  }
  return result;
}

export function requestFingerprints(kind: EndpointKind, payload: unknown): Record<string, string> {
  const object = boundedObject(payload);
  if (!object) return {};
  const candidates: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (kind === "responses") {
    candidates.instructions = object.instructions;
    candidates.tools = object.tools;
    candidates.first_user = firstUserMessage(kind, object);
    candidates.input_prefix = responseInputItems(object)
      .filter((item) => !isTaskContextMessage(item))
      .slice(0, 6)
      .map(responseItemSummary);
    candidates.input = object.input;
  } else if (kind === "chat" || kind === "messages") {
    const messages = boundedArray(object.messages);
    const system =
      kind === "messages" ? topLevelSystem(object.system) : chatSystemMessages(messages, ["system", "developer"]);
    const contentMessages = messages.filter((item) => !isTaskContextMessage(item)).map(messageSummary);
    candidates.system = system;
    candidates.messages_prefix = contentMessages.slice(0, 4);
    candidates.messages = contentMessages;
    candidates.first_user = firstUserMessage(kind, object);
    candidates.tools = object.tools ?? (kind === "chat" ? object.functions : undefined);
  } else if (kind === "completions") {
    candidates.prompt = object.prompt;
  }

  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(candidates)) {
    if (isPresent(value)) result[key] = stableHash(value);
  }
  return result;
}

export function requestBoundaryFingerprints(kind: EndpointKind, payload: unknown): Record<string, string> {
  const all = requestFingerprints(kind, payload);
  const keys =
    kind === "responses"
      ? new Set(["instructions", "first_user"])
      : kind === "chat" || kind === "messages"
        ? new Set(["system", "first_user"])
        : kind === "completions"
          ? new Set(["prompt"])
          : new Set<string>();
  return Object.fromEntries(Object.entries(all).filter(([key]) => keys.has(key)));
}

export function stableHash(value: unknown, length = 12): string {
  const bounded = boundedJson(value);
  return createHash("sha256").update(canonicalJson(bounded)).digest("hex").slice(0, Math.max(0, length));
}

export function summarizeRecordPayload(
  path: unknown,
  requestPayload: unknown,
  responsePayload: unknown,
  identifierContext: RequestIdentifierContext = {},
): RecordPayloadSummary {
  const endpoint = displayEndpoint(path);
  const kind = endpointKind(endpoint);
  try {
    const identifiers = requestIdentifiers(requestPayload, identifierContext);
    return {
      kind,
      endpoint,
      messageCount: requestMessageCount(kind, requestPayload),
      tokenCount: responseTokenCount(responsePayload),
      previousResponseId: identifiers.previousResponseId,
      responseIds: responseIdsFromBody(responsePayload),
      contextKeys: identifiers.contextKeys,
      fingerprints: requestFingerprints(kind, requestPayload),
      boundaryFingerprints: requestBoundaryFingerprints(kind, requestPayload),
      userMessages: requestUserMessages(kind, requestPayload),
    };
  } catch {
    return emptySummary(kind, endpoint);
  }
}

function firstUserMessage(kind: EndpointKind, payload: Record<string, unknown>): SanitizedJsonValue | null {
  const source = kind === "responses" ? responseInputItems(payload) : boundedArray(payload.messages);
  for (const item of source) {
    const message = asObject(item);
    if (message?.role !== "user" || isTaskContextMessage(message)) continue;
    if (kind === "responses" && Array.isArray(message.content)) {
      const texts = message.content
        .slice(0, MAX_TRAVERSED_ITEMS)
        .map((entry) => asObject(entry)?.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0);
      if (texts.length > 0) return boundedJson(texts);
    }
    return boundedJson(message.content);
  }
  return null;
}

function responseInputItems(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.input)) return payload.input.slice(0, MAX_TRAVERSED_ITEMS);
  return payload.input === null || payload.input === undefined ? [] : [payload.input];
}

function responseItemSummary(item: unknown): SanitizedJsonValue {
  const object = asObject(item);
  if (!object) return boundedJson(item);
  return compactObject({
    type: object.type,
    role: object.role,
    call_id: object.call_id,
    name: object.name,
    content: responseContentSummary(object.content),
    output: object.output,
    arguments: object.arguments,
  });
}

function responseContentSummary(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, MAX_TRAVERSED_ITEMS).map((item) => {
    const content = asObject(item);
    return content
      ? compactObject({
          type: content.type,
          text: content.text,
          arguments: content.arguments,
          call_id: content.call_id,
        })
      : boundedJson(item);
  });
}

function messageSummary(item: unknown): SanitizedJsonValue {
  const message = asObject(item);
  if (!message) return boundedJson(item);
  return compactObject({
    role: message.role,
    content: boundedJson(message.content),
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_use_id: message.tool_use_id,
  });
}

function chatSystemMessages(messages: readonly unknown[], roles: readonly string[]): SanitizedJsonValue[] {
  const allowed = new Set(roles);
  const result: SanitizedJsonValue[] = [];
  for (const item of messages) {
    const message = asObject(item);
    if (message && allowed.has(String(message.role))) {
      result.push(compactObject({ role: message.role, content: boundedJson(message.content) }));
    }
  }
  return result;
}

function topLevelSystem(value: unknown): SanitizedJsonValue[] {
  return value ? [compactObject({ role: "system", content: boundedJson(value) })] : [];
}

function isTaskContextMessage(value: unknown): boolean {
  const object = asObject(value);
  if (!object) return false;
  const text = contentText(object.content).trimStart();
  return CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const object = asObject(value);
  if (object && typeof object.text === "string") return object.text;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value.slice(0, MAX_TRAVERSED_ITEMS)) {
    if (typeof item === "string") parts.push(item);
    else {
      const entry = asObject(item);
      if (typeof entry?.text === "string") parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function boundedJson(value: unknown): SanitizedJsonValue {
  return sanitizeJsonValue(value, {
    maxDepth: MAX_FINGERPRINT_DEPTH,
    maxItems: MAX_TRAVERSED_ITEMS,
    maxStringBytes: MAX_FINGERPRINT_STRING_BYTES,
  });
}

function boundedObject(value: unknown): Record<string, unknown> | null {
  return asObject(boundedJson(value));
}

function compactObject(input: Record<string, unknown>): Record<string, SanitizedJsonValue> {
  const result: Record<string, SanitizedJsonValue> = Object.create(null) as Record<string, SanitizedJsonValue>;
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) result[key] = boundedJson(value);
  }
  return result;
}

function canonicalJson(value: SanitizedJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as SanitizedJsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_TRAVERSED_ITEMS) : [];
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function prefixString(prefix: string, value: unknown): string | null {
  const text = firstString(value);
  return text ? `${prefix}:${text}` : null;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function emptySummary(kind: EndpointKind, endpoint: string): RecordPayloadSummary {
  return {
    kind,
    endpoint,
    messageCount: null,
    tokenCount: null,
    previousResponseId: null,
    responseIds: [],
    contextKeys: [],
    fingerprints: {},
    boundaryFingerprints: {},
    userMessages: [],
  };
}
