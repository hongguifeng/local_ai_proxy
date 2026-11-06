import { isRecord } from "../shared/index.js";

import type { HeaderEntry } from "./headers.js";
import {
  endpointKind,
  requestBoundaryFingerprints,
  requestUserMessages,
  stableHash,
  type EndpointKind,
} from "./protocol/analysis.js";
import { boundaryWithoutUser, modelFromPayload } from "./protocol/task-identity.js";

/**
 * Session identity on the forwarded request. Some upstreams reject a request that carries no
 * session header at all (OpenCode Go answers 400 `MissingSessionID`), and a client does not
 * always send one on every path - pi's context compaction requests carry none. A target may
 * therefore name one header (`targets[].session_header`) that the proxy guarantees is present.
 *
 * The guarantee is deliberately narrow: an existing value is never replaced, because the
 * client's own session decides its routing and prompt cache. Only a request with no session
 * evidence at all gets a value this module invents, and that value is a stable function of the
 * conversation's first turn so consecutive turns and repeated compaction calls of one
 * conversation share a bucket. See ADR-016.
 */

/**
 * Client headers that already name a conversation, in the order this module prefers. `session_id`
 * is what the OpenAI-compatible paths send, `x-session-affinity` is the transport-level spelling,
 * and `x-claude-code-session-id` is the Anthropic one; the configured name itself is checked
 * before any of these, so a client that already sends the upstream's own header is untouched.
 */
export const SESSION_HEADER_ALIASES: readonly string[] = [
  "session_id",
  "x-session-affinity",
  "x-claude-code-session-id",
];

/** Only the opening of the first user text identifies a conversation; the rest is history. */
export const SESSION_TEXT_PREFIX_CHARS = 4_096;

/** Hex digits in a derived id: 96 bits, long enough that two conversations never collide. */
const DERIVED_ID_HASH_LENGTH = 24;

export interface SessionHeaderPlan {
  readonly name: string;
  readonly value: string;
  /** `alias` copied a client header; `derived` had to invent one from the request. */
  readonly source: "alias" | "derived";
}

export interface SessionHeaderInput {
  /** The configured header name; empty or absent means the feature is off. */
  readonly name: string | undefined;
  /** Headers already planned for the upstream request, after target overrides. */
  readonly headers: readonly HeaderEntry[];
  /** The request body as it will be forwarded, or nothing when it was not read. */
  readonly body: Uint8Array | undefined;
  readonly path: string;
}

export function headerEntryValue(
  headers: readonly HeaderEntry[],
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  for (const [entryName, entryValue] of headers) {
    if (entryName.toLowerCase() === lowered) {
      return entryValue;
    }
  }
  return undefined;
}

/**
 * The client's own session id, copied verbatim. An empty value is not evidence of a session, so
 * it is skipped rather than forwarded as an empty header.
 */
export function sessionAliasValue(headers: readonly HeaderEntry[]): string | undefined {
  for (const alias of SESSION_HEADER_ALIASES) {
    const value = headerEntryValue(headers, alias)?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * A conversation-stable id for a request that carried no session evidence. The inputs are chosen
 * so that growing history does not change the answer: the first user text is cut to its opening
 * characters, and the `first_user` boundary fingerprint - which for a compaction request is the
 * whole conversation - is left out.
 */
export function derivedSessionId(kind: EndpointKind, payload: unknown, path: string): string {
  const boundary = boundaryWithoutUser(requestBoundaryFingerprints(kind, payload));
  const firstUserPrefix = firstUserTextPrefix(kind, payload);
  const hashInput =
    firstUserPrefix === ""
      ? { kind, path }
      : { kind, model: modelFromPayload(payload), boundary, firstUserPrefix };
  return `proxy-${stableHash(hashInput, DERIVED_ID_HASH_LENGTH)}`;
}

/**
 * The header to add, or nothing when the feature is off or the request already carries the
 * configured name. Parsing the body only happens when it is actually needed.
 */
export function planSessionHeader(input: SessionHeaderInput): SessionHeaderPlan | undefined {
  const name = input.name?.trim() ?? "";
  if (name === "" || headerEntryValue(input.headers, name) !== undefined) {
    return undefined;
  }
  const alias = sessionAliasValue(input.headers);
  if (alias !== undefined) {
    return { name, value: alias, source: "alias" };
  }
  const kind = endpointKind(input.path);
  return {
    name,
    value: derivedSessionId(kind, parsePayload(input.body), input.path),
    source: "derived",
  };
}

function parsePayload(body: Uint8Array | undefined): unknown {
  if (body === undefined || body.byteLength === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The opening characters of the first user message, walked from the same projection the task
 * matcher uses. A compaction request puts the whole conversation in that message, which is why
 * the walk stops at `SESSION_TEXT_PREFIX_CHARS` instead of materializing it.
 */
export function firstUserTextPrefix(
  kind: EndpointKind,
  payload: unknown,
  limit = SESSION_TEXT_PREFIX_CHARS,
): string {
  const firstUserMessage = requestUserMessages(kind, payload)[0];
  return boundedText(firstUserMessage, limit);
}

/** Depth-first text of a JSON value, in document order, cut at `limit` characters. */
function boundedText(value: unknown, limit: number): string {
  const parts: string[] = [];
  let used = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && used < limit) {
    const current = pending.pop();
    if (typeof current === "string") {
      const separator = parts.length > 0 ? 1 : 0;
      const room = limit - used - separator;
      if (room <= 0) {
        break;
      }
      const taken = current.slice(0, room);
      parts.push(taken);
      used += taken.length + separator;
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]);
      }
      continue;
    }
    if (isRecord(current)) {
      const values = Object.values(current);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push(values[index]);
      }
    }
  }
  return parts.join("\u0000");
}
