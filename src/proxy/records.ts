export type EndpointKind = "responses" | "messages" | "chat" | "completions" | "other";

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
import { isRecord } from "../shared/index.js";
