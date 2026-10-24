import { isRecord, stableJsonStringify } from "../shared/index.js";

import {
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestUserMessages,
  stableHash,
  type EndpointKind,
} from "./records.js";

/**
 * Shared task identity projections. Both the request router (which decides which
 * upstream node receives a request) and the logging `TaskMatcher` (which groups
 * records into tasks in the traffic database) must agree on what "the same task"
 * means, so the projections live here once and are never re-implemented.
 *
 * The router is allowed to be looser than the matcher: merging two independent
 * tasks onto one node only skews traffic, while splitting one task across two
 * nodes destroys KV cache affinity. Anything that makes the router stricter has
 * to be called out explicitly.
 */

/** Above this many user messages the identity is treated as oversized. */
export const MAX_TASK_USER_MESSAGES = 4_096;
/** Only this many user message hashes are kept for affinity matching. */
export const MAX_TASK_USER_HASHES = 64;

/** Headers exactly as the proxy stores them: a name maps to one or more values. */
export type RequestHeaderMap = Readonly<Record<string, unknown>>;

export interface TaskIdentityInput {
  readonly payload: unknown;
  readonly headers?: RequestHeaderMap | undefined;
  readonly path?: string | undefined;
}

export interface TaskIdentity {
  readonly kind: EndpointKind;
  readonly endpoint: string;
  readonly model: string | undefined;
  readonly boundary: Readonly<Record<string, string>>;
  readonly boundaryWithoutUser: Readonly<Record<string, string>>;
  readonly userHashes: readonly string[];
  readonly contentFingerprint: string | undefined;
  readonly exactKeys: readonly string[];
  /** True when the user message list was longer than the retained hash budget. */
  readonly bounded: boolean;
  /** True when the conversation is beyond the guard and must rely on exact keys. */
  readonly oversize: boolean;
}

/** Build the evidence the router stores with an affinity binding. */
export function taskIdentity(input: TaskIdentityInput): TaskIdentity {
  const endpoint = input.path ?? "";
  const kind = endpointKind(endpoint);
  const payload = input.payload;
  const model = modelFromPayload(payload);
  const boundary = requestBoundaryFingerprints(kind, payload);
  const messageCount = requestUserMessages(kind, payload).length;
  const { hashes, bounded } = userMessageHashes(kind, payload);

  return {
    kind,
    endpoint,
    model,
    boundary,
    boundaryWithoutUser: boundaryWithoutUser(boundary),
    userHashes: hashes,
    contentFingerprint: contentFingerprint(kind, payload),
    exactKeys: taskExactKeys(payload, input.headers),
    bounded,
    oversize: messageCount > MAX_TASK_USER_MESSAGES,
  };
}

/**
 * Context keys reachable from the request itself, in the order the matcher has
 * always preferred: conversation id, prompt cache key, then the Claude session
 * header. Response ids are not part of this list; they are learned from response
 * bodies and registered separately.
 */
export function requestContextKeys(
  payload: unknown,
  headers: RequestHeaderMap | undefined,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  addContextKey(keys, seen, "conversation", conversationIdFrom(payload));
  addContextKey(keys, seen, "prompt_cache", payloadText(payload, "prompt_cache_key"));
  addContextKey(keys, seen, "claude_session", headerValue(headers, "x-claude-code-session-id"));
  return keys;
}

/**
 * Keys that exist only in stored records, never in a live request. They stay as a
 * history/import fallback for the matcher and must not be assumed available by the
 * router. The legacy order put them before the Claude session key, which this merge
 * preserves.
 */
export function mergeLegacyContextKeys(
  runtimeKeys: readonly string[],
  legacyKeys: readonly string[],
): string[] {
  if (legacyKeys.length === 0) {
    return [...runtimeKeys];
  }
  const found = runtimeKeys.findIndex((key) => key.startsWith("claude_session:"));
  const insertAt = found === -1 ? runtimeKeys.length : found;
  return [...runtimeKeys.slice(0, insertAt), ...legacyKeys, ...runtimeKeys.slice(insertAt)];
}

export function addContextKey(
  keys: string[],
  seen: Set<string>,
  prefix: string,
  value: unknown,
): void {
  const text = textField(value);
  if (text === "") {
    return;
  }
  const key = `${prefix}:${text}`;
  if (!seen.has(key)) {
    seen.add(key);
    keys.push(key);
  }
}

/** Ordered exact keys the router can look up: response chain first. */
export function taskExactKeys(payload: unknown, headers: RequestHeaderMap | undefined): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  addContextKey(keys, seen, "response", payloadText(payload, "previous_response_id"));
  for (const key of requestContextKeys(payload, headers)) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function conversationIdFrom(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const conversation = payload["conversation"];
  return firstString(
    conversation,
    nestedValue(conversation, "id"),
    payload["conversation_id"],
    payload["thread_id"],
    nestedValue(payload, "metadata", "conversation_id"),
    nestedValue(payload, "metadata", "thread_id"),
    nestedValue(payload, "metadata", "session_id"),
  );
}

/** The static boundary without the first user message, used by exact lookups. */
export function boundaryWithoutUser(
  boundary: Readonly<Record<string, string>>,
): Record<string, string> {
  const copy = { ...boundary };
  delete copy["first_user"];
  return copy;
}

export function userMessageHashes(
  kind: EndpointKind,
  payload: unknown,
  limit = MAX_TASK_USER_HASHES,
): { readonly hashes: string[]; readonly bounded: boolean } {
  const messages = requestUserMessages(kind, payload);
  return {
    hashes: messages.slice(0, limit).map((message) => userMessageHash(message)),
    bounded: messages.length > limit,
  };
}

export function userMessageHash(message: unknown): string {
  return stableHash(message);
}

/**
 * Fingerprint of the changing part of a request. It differs exactly when the
 * matcher's continuation evidence differs.
 */
export function contentFingerprint(kind: EndpointKind, payload: unknown): string | undefined {
  const fingerprints = requestFingerprints(kind, payload);
  const input = fingerprints["input"];
  const messages = fingerprints["messages"];
  if (typeof input !== "string" && typeof messages !== "string") {
    return undefined;
  }
  return stableHash({ input, messages });
}

/** True when the current messages begin with exactly the stored previous ones. */
export function userMessagesPrefixMatches(
  previousUserMessages: readonly unknown[],
  currentUserMessages: readonly unknown[],
): boolean {
  if (
    previousUserMessages.length === 0 ||
    currentUserMessages.length === 0 ||
    previousUserMessages.length > currentUserMessages.length
  ) {
    return false;
  }
  return (
    stableJsonStringify(currentUserMessages.slice(0, previousUserMessages.length)) ===
    stableJsonStringify(previousUserMessages)
  );
}

/** Same comparison over stored hashes instead of stored JSON values. */
export function userHashPrefixMatches(
  previousHashes: readonly string[],
  currentHashes: readonly string[],
): boolean {
  if (
    previousHashes.length === 0 ||
    currentHashes.length === 0 ||
    previousHashes.length > currentHashes.length
  ) {
    return false;
  }
  for (const [index, hash] of previousHashes.entries()) {
    if (currentHashes[index] !== hash) {
      return false;
    }
  }
  return true;
}

/**
 * Evidence that this request continues a conversation rather than repeating it:
 * more user messages than before, or a changed input/messages fingerprint. A short
 * window of identical bodies is handled by the affinity layer, not here.
 */
export function hasContinuationEvidence(
  kind: EndpointKind,
  payload: unknown,
  previousUserMessages: readonly unknown[] | undefined,
  previousFingerprints: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const currentUserMessages = requestUserMessages(kind, payload);
  if (
    previousUserMessages !== undefined &&
    currentUserMessages.length > previousUserMessages.length
  ) {
    return true;
  }
  if (!isRecord(previousFingerprints)) {
    return false;
  }
  const currentFingerprints = requestFingerprints(kind, payload);
  return ["input", "messages"].some(
    (key) =>
      typeof previousFingerprints[key] === "string" &&
      typeof currentFingerprints[key] === "string" &&
      previousFingerprints[key] !== currentFingerprints[key],
  );
}

export function nestedValue(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function headerValue(headers: unknown, requestedName: string): unknown {
  if (!isRecord(headers)) {
    return undefined;
  }
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === requestedName.toLowerCase(),
  );
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = textField(value);
    if (text !== "") {
      return text;
    }
  }
  return undefined;
}

/** Trimmed text of a string value; empty for anything else, matching the matcher. */
export function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function modelFromPayload(payload: unknown): string | undefined {
  const model = payloadText(payload, "model");
  return model === "" ? undefined : model;
}

function payloadText(payload: unknown, key: string): string {
  return textField(isRecord(payload) ? payload[key] : undefined);
}
