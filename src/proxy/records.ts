import { createHash } from "node:crypto";

import { isRecord, stableJsonStringify } from "../shared/index.js";

export type EndpointKind = "responses" | "messages" | "chat" | "completions" | "other";

export function stableHash(value: unknown, length = 12): string {
  return createHash("sha256")
    .update(stableJsonStringify(value), "utf8")
    .digest("hex")
    .slice(0, length);
}

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
  const tokenKeys = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const;
  const values = tokenKeys
    .map((key) => usage[key])
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value));
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

export function requestFingerprints(kind: EndpointKind, payload: unknown): Record<string, string> {
  if (!isRecord(payload)) {
    return {};
  }
  const fingerprints: Record<string, string> = {};
  if (kind === "chat") {
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
  } else if (kind === "completions" && isPythonTruthy(payload["prompt"])) {
    fingerprints["prompt"] = stableHash(payload["prompt"]);
  }
  return fingerprints;
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
