import { createHash } from "node:crypto";

import { isRecord, stableJsonStringify } from "../shared/index.js";

export type EndpointKind = "responses" | "messages" | "chat" | "completions" | "other";

export function stableHash(value: unknown, length = 12): string {
  return createHash("sha256")
    .update(stableJsonStringify(value), "utf8")
    .digest("hex")
    .slice(0, length);
}

const CLAUDE_TRANSIENT_TASK_FIELDS = new Set(["cache_control"]);

export function endpointKind(path: string): EndpointKind {
  const lowered = path.toLowerCase().split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  if (lowered === "/responses" || lowered.endsWith("/responses")) {
    return "responses";
  }
  if (lowered === "/messages" || lowered.endsWith("/messages")) {
    return "messages";
  }
  if (lowered === "/chat/completions" || lowered.endsWith("/chat/completions")) {
    return "chat";
  }
  if (lowered === "/completions" || lowered.endsWith("/completions")) {
    return "completions";
  }
  return "other";
}

export function displayEndpoint(path: string | number | boolean | null | undefined): string {
  const value = (path ? String(path) : "").split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  return value || "/";
}

export function requestMessageCount(kind: EndpointKind, payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (kind === "responses") {
    const input = payload["input"];
    const count = Array.isArray(input)
      ? input.length
      : input === null || input === undefined
        ? 0
        : 1;
    return count + (isPythonTruthy(payload["instructions"]) ? 1 : 0);
  }
  if (kind === "messages") {
    const system = payload["system"];
    const systemCount = Array.isArray(system) ? system.length : isPythonTruthy(system) ? 1 : 0;
    const messages = payload["messages"];
    return systemCount + (Array.isArray(messages) ? messages.length : 0);
  }
  if (kind === "chat") {
    const messages = payload["messages"];
    return Array.isArray(messages) ? messages.length : 0;
  }
  if (kind === "completions") {
    const prompt = payload["prompt"];
    return Array.isArray(prompt) ? prompt.length : prompt === null || prompt === undefined ? 0 : 1;
  }
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    return messages.length;
  }
  const input = payload["input"];
  if (Array.isArray(input)) {
    return input.length;
  }
  return input === null || input === undefined ? undefined : 1;
}

export function responseTokenCount(payload: unknown): number | undefined {
  const usage = responseUsage(payload);
  if (!isRecord(usage)) {
    return undefined;
  }
  const total = usage["total_tokens"];
  if (typeof total === "number" && Number.isInteger(total)) {
    return total;
  }
  const counts = responseTokenCounts(payload);
  const values = [counts.request, counts.response].filter(
    (value): value is number => value !== undefined,
  );
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

export interface ResponseTokenCounts {
  readonly request: number | undefined;
  readonly response: number | undefined;
}

export function responseTokenCounts(payload: unknown): ResponseTokenCounts {
  const usage = responseUsage(payload);
  if (!isRecord(usage)) {
    return { request: undefined, response: undefined };
  }
  const input = tokenValue(usage, "input_tokens") ?? tokenValue(usage, "prompt_tokens");
  const cachedInputValues = ["cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => tokenValue(usage, key))
    .filter((value): value is number => value !== undefined);
  const cachedInput = cachedInputValues.reduce((sum, value) => sum + value, 0);
  return {
    request:
      input === undefined && cachedInputValues.length === 0
        ? undefined
        : (input ?? 0) + cachedInput,
    response: tokenValue(usage, "output_tokens") ?? tokenValue(usage, "completion_tokens"),
  };
}

export function responseIdsFromBody(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }
  const ids: string[] = [];
  const responseId = body["id"];
  if (typeof responseId === "string" && responseId !== "") {
    ids.push(responseId);
  }
  const response = body["response"];
  const nestedId = isRecord(response) ? response["id"] : undefined;
  if (typeof nestedId === "string" && nestedId !== "" && !ids.includes(nestedId)) {
    ids.push(nestedId);
  }
  return ids;
}

export function requestFingerprints(kind: EndpointKind, payload: unknown): Record<string, string> {
  if (!isRecord(payload)) {
    return {};
  }
  const fingerprints: Record<string, string> = {};
  if (kind === "responses") {
    for (const key of ["instructions", "tools"] as const) {
      if (isPythonTruthy(payload[key])) {
        fingerprints[key] = stableHash(payload[key]);
      }
    }
    const firstUser = responsesFirstUserMessage(payload);
    if (isPythonTruthy(firstUser)) {
      fingerprints["first_user"] = stableHash(firstUser);
    }
    const inputPrefix = responsesInputPrefix(payload);
    if (inputPrefix.length > 0) {
      fingerprints["input_prefix"] = stableHash(inputPrefix);
    }
    if (isPythonTruthy(payload["input"])) {
      fingerprints["input"] = stableHash(payload["input"]);
    }
  } else if (kind === "chat") {
    const systemMessages = chatSystemMessages(payload);
    if (systemMessages.length > 0) {
      fingerprints["system"] = stableHash(systemMessages);
    }
    const prefixMessages = chatMessages(payload, 4);
    if (prefixMessages.length > 0) {
      fingerprints["messages_prefix"] = stableHash(prefixMessages);
    }
    const contentMessages = chatMessages(payload);
    if (contentMessages.length > 0) {
      fingerprints["messages"] = stableHash(contentMessages);
    }
    const firstUser = chatFirstUserMessage(payload);
    if (isPythonTruthy(firstUser)) {
      fingerprints["first_user"] = stableHash(firstUser);
    }
    const tools = Object.hasOwn(payload, "tools") ? payload["tools"] : payload["functions"];
    if (isPythonTruthy(tools)) {
      fingerprints["tools"] = stableHash(tools);
    }
  } else if (kind === "messages") {
    const systemMessages = claudeSystemMessages(payload);
    if (systemMessages.length > 0) {
      fingerprints["system"] = stableHash(systemMessages);
    }
    const prefixMessages = claudeMessages(payload).slice(0, 4);
    if (prefixMessages.length > 0) {
      fingerprints["messages_prefix"] = stableHash(prefixMessages);
    }
    const contentMessages = claudeMessages(payload);
    if (contentMessages.length > 0) {
      fingerprints["messages"] = stableHash(contentMessages);
    }
    const firstUser = claudeFirstUserMessage(payload);
    if (isPythonTruthy(firstUser)) {
      fingerprints["first_user"] = stableHash(firstUser);
    }
    if (isPythonTruthy(payload["tools"])) {
      fingerprints["tools"] = stableHash(claudeTaskValue(payload["tools"]));
    }
  } else if (kind === "completions" && isPythonTruthy(payload["prompt"])) {
    fingerprints["prompt"] = stableHash(payload["prompt"]);
  }
  return fingerprints;
}

export function requestBoundaryFingerprints(
  kind: EndpointKind,
  payload: unknown,
): Record<string, string> {
  const fingerprints = requestFingerprints(kind, payload);
  const boundaryKeys =
    kind === "responses"
      ? new Set(["instructions", "first_user"])
      : kind === "chat" || kind === "messages"
        ? new Set(["system", "first_user"])
        : kind === "completions"
          ? new Set(["prompt"])
          : new Set<string>();
  return Object.fromEntries(Object.entries(fingerprints).filter(([key]) => boundaryKeys.has(key)));
}

export function requestUserMessages(kind: EndpointKind, payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
  }
  if (kind === "responses") {
    return responsesInputItems(payload)
      .filter((item) => isRecord(item) && item["role"] === "user" && !isTaskContextMessage(item))
      .map((item) => responsesInputItemSummary(item));
  }
  if (kind === "chat") {
    const messages = payload["messages"];
    const userMessages: unknown[] = [];
    for (const message of Array.isArray(messages) ? (messages as unknown[]) : []) {
      if (isRecord(message) && message["role"] === "user" && !isTaskContextMessage(message)) {
        userMessages.push({
          role: message["role"] ?? null,
          content: messageText(message["content"]),
          name: message["name"] ?? null,
        });
      }
    }
    return userMessages;
  }
  if (kind === "messages") {
    const messages = payload["messages"];
    const userMessages: unknown[] = [];
    for (const message of Array.isArray(messages) ? (messages as unknown[]) : []) {
      if (isRecord(message) && message["role"] === "user" && !isTaskContextMessage(message)) {
        userMessages.push(claudeMessageSummary(message));
      }
    }
    return userMessages;
  }
  if (kind === "completions" && isPythonTruthy(payload["prompt"])) {
    return [messageText(payload["prompt"])];
  }
  return [];
}

function responsesInputItems(payload: Readonly<Record<string, unknown>>): unknown[] {
  const input = payload["input"];
  if (Array.isArray(input)) {
    return input;
  }
  return input === null || input === undefined ? [] : [input];
}

function responsesInputItemSummary(item: unknown): unknown {
  if (typeof item === "string" || !isRecord(item)) {
    return item;
  }
  const summary: Record<string, unknown> = {};
  for (const key of ["type", "role", "call_id", "name"] as const) {
    if (item[key] !== null && item[key] !== undefined) {
      summary[key] = item[key];
    }
  }
  const content = item["content"];
  if (Array.isArray(content)) {
    summary["content"] = (content as unknown[]).map((contentItem) => {
      if (!isRecord(contentItem)) {
        return contentItem;
      }
      return Object.fromEntries(
        ["type", "text", "arguments", "call_id"]
          .filter((key) => contentItem[key] !== null && contentItem[key] !== undefined)
          .map((key) => [key, contentItem[key]]),
      );
    });
  } else if (content !== null && content !== undefined) {
    summary["content"] = messageText(content);
  }
  for (const key of ["output", "arguments"] as const) {
    if (item[key] !== null && item[key] !== undefined) {
      summary[key] = messageText(item[key]);
    }
  }
  return Object.keys(summary).length > 0 ? summary : messageText(item);
}

function responsesInputPrefix(payload: Readonly<Record<string, unknown>>): unknown[] {
  return responsesInputItems(payload)
    .filter((item) => !isTaskContextMessage(item))
    .slice(0, 6)
    .map((item) => responsesInputItemSummary(item));
}

function responsesFirstUserMessage(payload: Readonly<Record<string, unknown>>): unknown {
  for (const item of responsesInputItems(payload)) {
    if (!isRecord(item) || item["role"] !== "user" || isTaskContextMessage(item)) {
      continue;
    }
    const content = item["content"];
    if (Array.isArray(content)) {
      const texts = (content as unknown[])
        .filter(
          (contentItem) =>
            isRecord(contentItem) &&
            typeof contentItem["text"] === "string" &&
            contentItem["text"] !== "",
        )
        .map((contentItem) => (contentItem as Record<string, unknown>)["text"]);
      if (texts.length > 0) {
        return texts;
      }
    } else if (isPythonTruthy(content)) {
      return messageText(content);
    }
  }
  return undefined;
}

function claudeSystemMessages(payload: Readonly<Record<string, unknown>>): unknown[] {
  const system = payload["system"];
  return isPythonTruthy(system) ? [{ role: "system", content: claudeTaskValue(system) }] : [];
}

function claudeMessageSummary(message: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    role: message["role"] ?? null,
    content: claudeTaskValue(message["content"]),
  };
  for (const key of ["name", "tool_use_id"] as const) {
    if (message[key] !== null && message[key] !== undefined) {
      summary[key] = message[key];
    }
  }
  return summary;
}

function claudeMessages(payload: Readonly<Record<string, unknown>>): unknown[] {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return [];
  }
  const compacted: unknown[] = [];
  for (const message of messages as unknown[]) {
    if (isRecord(message) && !isTaskContextMessage(message)) {
      compacted.push(claudeMessageSummary(message));
    }
  }
  return compacted;
}

function claudeFirstUserMessage(payload: Readonly<Record<string, unknown>>): unknown {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const message of messages as unknown[]) {
    if (isRecord(message) && message["role"] === "user" && !isTaskContextMessage(message)) {
      return claudeTaskValue(message["content"]);
    }
  }
  return undefined;
}

function claudeTaskValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => claudeTaskValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !CLAUDE_TRANSIENT_TASK_FIELDS.has(key))
        .sort()
        .map((key) => [key, claudeTaskValue(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

function messageText(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => messageText(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, messageText(value[key])]),
    );
  }
  return value;
}

function chatSystemMessages(payload: Readonly<Record<string, unknown>>): unknown[] {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return [];
  }
  const systemMessages: unknown[] = [];
  for (const message of messages as unknown[]) {
    if (isRecord(message) && (message["role"] === "system" || message["role"] === "developer")) {
      systemMessages.push({
        role: message["role"] ?? null,
        content: messageText(message["content"]),
      });
    }
  }
  return systemMessages;
}

function chatMessages(payload: Readonly<Record<string, unknown>>, limit?: number): unknown[] {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return [];
  }
  const compacted: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message) || isTaskContextMessage(message)) {
      continue;
    }
    compacted.push({
      role: message["role"] ?? null,
      content: messageText(message["content"]),
      name: message["name"] ?? null,
      tool_call_id: message["tool_call_id"] ?? null,
    });
    if (limit !== undefined && compacted.length >= limit) {
      break;
    }
  }
  return compacted;
}

function chatFirstUserMessage(payload: Readonly<Record<string, unknown>>): unknown {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const message of messages) {
    if (isRecord(message) && message["role"] === "user" && !isTaskContextMessage(message)) {
      return messageText(message["content"]);
    }
  }
  return undefined;
}

export function isTaskContextMessage(item: unknown): boolean {
  if (!isRecord(item)) {
    return false;
  }
  const text = contentText(item["content"]).trimStart();
  return [
    "<environment_context>",
    "<permissions instructions>",
    "<app-context>",
    "# Codex desktop context",
  ].some((prefix) => text.startsWith(prefix));
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === "string") {
          return [item];
        }
        return isRecord(item) && typeof item["text"] === "string" ? [item["text"]] : [];
      })
      .join("\n");
  }
  return isRecord(value) && typeof value["text"] === "string" ? value["text"] : "";
}

function responseUsage(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const streamSummary = payload["stream_summary"];
  if (isRecord(streamSummary) && isPythonTruthy(streamSummary["usage"])) {
    return streamSummary["usage"];
  }
  if (isPythonTruthy(payload["usage"])) {
    return payload["usage"];
  }
  const response = payload["response"];
  return isRecord(response) && isPythonTruthy(response["usage"]) ? response["usage"] : undefined;
}

function tokenValue(usage: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isPythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}
