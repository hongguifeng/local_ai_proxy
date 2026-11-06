import { describe, expect, it } from "vitest";

import {
  SESSION_TEXT_PREFIX_CHARS,
  derivedSessionId,
  firstUserTextPrefix,
  headerEntryValue,
  planSessionHeader,
  sessionAliasValue,
  type SessionHeaderInput,
} from "../../src/proxy/session-header.js";
import type { HeaderEntry } from "../../src/proxy/headers.js";

const NAME = "x-opencode-session";
const DERIVED_PATTERN = /^proxy-[0-9a-f]{24}$/u;

function body(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A chat conversation whose history grows the way a real turn grows it. */
function chatTurn(turns: readonly string[]): Uint8Array {
  return body({
    model: "test-model",
    messages: turns.flatMap((text) => [
      { role: "user", content: text },
      { role: "assistant", content: "ack" },
    ]),
  });
}

/** The shape pi's context compaction sends: one summarizer message, then the transcript. */
function compactionBody(transcript: string): Uint8Array {
  return body({
    model: "test-model",
    input: [
      {
        role: "developer",
        content: "You are a context summarization assistant. Produce a structured summary.",
      },
      {
        role: "user",
        content: [{ type: "input_text", text: `<conversation>\n${transcript}` }],
      },
    ],
    stream: true,
    store: false,
  });
}

function plan(overrides: Partial<SessionHeaderInput> = {}): ReturnType<typeof planSessionHeader> {
  return planSessionHeader({
    name: NAME,
    headers: [],
    body: chatTurn(["hello"]),
    path: "/v1/chat/completions",
    ...overrides,
  });
}

describe("session header planning", () => {
  it.each([undefined, "", "   "])("plans nothing when the target names no header (%j)", (name) => {
    expect(plan({ name })).toBeUndefined();
  });

  it("plans nothing when the forwarded set already carries the header in any casing", () => {
    const headers: readonly HeaderEntry[] = [["X-OpenCode-Session", "client-value"]];
    expect(plan({ headers })).toBeUndefined();
    expect(headerEntryValue(headers, NAME)).toBe("client-value");
  });

  it("copies the client's own session header instead of inventing one", () => {
    expect(plan({ headers: [["session_id", "client-session"]] })).toEqual({
      name: NAME,
      value: "client-session",
      source: "alias",
    });
  });

  it("prefers session_id over the other aliases and skips an empty value", () => {
    expect(
      sessionAliasValue([
        ["session_id", "   "],
        ["x-session-affinity", "affinity-session"],
        ["x-claude-code-session-id", "claude-session"],
      ]),
    ).toBe("affinity-session");
    expect(
      sessionAliasValue([
        ["x-claude-code-session-id", "claude-session"],
        ["session_id", "primary-session"],
      ]),
    ).toBe("primary-session");
    expect(sessionAliasValue([])).toBeUndefined();
  });

  it("derives one id for every turn of the same conversation", () => {
    const first = plan({ body: chatTurn(["explain the binder driver"]) });
    const second = plan({ body: chatTurn(["explain the binder driver", "and now the proxy"]) });
    const third = plan({
      body: chatTurn(["explain the binder driver", "and now the proxy", "what about threading"]),
    });
    expect(first?.source).toBe("derived");
    expect(first?.value).toMatch(DERIVED_PATTERN);
    expect(second?.value).toBe(first?.value);
    expect(third?.value).toBe(first?.value);
  });

  it("derives one id for repeated compaction requests of one conversation", () => {
    // A compaction request only happens once the transcript is large, and the id is settled by
    // the first 4 KB of it: every later compaction of the same conversation keeps that opening.
    const opening = "[User]: 继续排查 binder 线程池\n".repeat(600);
    const first = plan({ body: compactionBody(opening), path: "/v1/responses" });
    const second = plan({
      body: compactionBody(`${opening}[User]: 还有别的线索吗\n[Assistant]: ...`),
      path: "/v1/responses",
    });
    expect(first?.value).toMatch(DERIVED_PATTERN);
    expect(second?.value).toBe(first?.value);
  });

  it("gives a short transcript a new id once it grows past the hashed prefix", () => {
    // Stated as a behaviour, not a defect: below the prefix length the whole transcript is the
    // evidence, so two compactions of a tiny conversation are two different sessions.
    const short = plan({ body: compactionBody("[User]: hi"), path: "/v1/responses" });
    const longer = plan({
      body: compactionBody("[User]: hi\n[User]: still here"),
      path: "/v1/responses",
    });
    expect(longer?.value).not.toBe(short?.value);
  });

  it("derives different ids for different conversations", () => {
    const one = plan({ body: chatTurn(["first conversation"]) });
    const two = plan({ body: chatTurn(["second conversation"]) });
    expect(one?.value).not.toBe(two?.value);
  });

  it("falls back to the path when the body carries no user text", () => {
    const json = plan({ body: body({ model: "test-model" }) });
    const other = plan({ body: body({ model: "test-model" }), path: "/v1/embeddings" });
    const raw = plan({ body: new TextEncoder().encode("not json at all") });
    expect(json?.value).toMatch(DERIVED_PATTERN);
    expect(other?.value).not.toBe(json?.value);
    expect(raw?.value).toBe(json?.value);
    expect(plan({ body: undefined })?.value).toBe(json?.value);
    expect(derivedSessionId("chat", { model: "test-model" }, "/v1/chat/completions")).toBe(
      json?.value,
    );
  });

  it("bounds the first user text it hashes", () => {
    const huge = "x".repeat(SESSION_TEXT_PREFIX_CHARS * 4);
    const prefix = firstUserTextPrefix("chat", {
      messages: [{ role: "user", content: huge }],
    });
    expect(prefix.length).toBeLessThanOrEqual(SESSION_TEXT_PREFIX_CHARS);
    // The walk keeps document order, so after the role it is the opening of the content.
    const content = prefix.startsWith("user") ? prefix.slice("user".length + 1) : prefix;
    expect(content.length).toBeGreaterThan(SESSION_TEXT_PREFIX_CHARS - 16);
    expect(huge.startsWith(content)).toBe(true);
  });
});
