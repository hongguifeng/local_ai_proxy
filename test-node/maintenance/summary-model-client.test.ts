import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";

import { SummaryModelClient } from "../../src/maintenance/summary-model-client.js";
import { ApplicationError } from "../../src/shared/index.js";
import type { SummaryModelConfig } from "../../src/config/index.js";

/**
 * [AI-11] The summary-model client: the one object that turns a configuration and a
 * prompt into an upstream HTTP request, and the answer back.
 *
 * The wire is pinned here as text, because a summary model has to keep seeing the
 * request the project has always sent it: the same URL, the same headers, the same
 * serialized body including the order its fields are written in. Failure reporting is
 * pinned as well - the code, the status and the message a caller may show - so moving
 * the transport into its own module cannot change what the console answers.
 */

const servers: Server[] = [];

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function urlFor(server: Server, path = ""): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

afterAll(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function config(overrides: Partial<SummaryModelConfig> = {}): SummaryModelConfig {
  return {
    disable_reasoning: true,
    api_type: "openai_chat",
    target_url: "https://summary.example.com/v1",
    api_key: "summary-secret",
    model: "summary-model",
    target_headers: [],
    timeout_ms: 30_000,
    ...overrides,
  };
}

const prompt = { instruction: "answer in JSON", input: "the prepared input" };

function chatAnswer(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The parts of a stubbed call worth recording. */
interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
}

function recordCall(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  calls: RecordedCall[],
): void {
  const headers: Record<string, string> = {};
  for (const [name, value] of new Headers(init?.headers ?? {})) headers[name] = value;
  calls.push({
    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    method: init?.method ?? "",
    headers,
    body: typeof init?.body === "string" ? init.body : "",
    signal: init?.signal ?? undefined,
  });
}

describe("SummaryModelClient", () => {
  it("sends a chat completion with a system turn and reasoning turned off", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(chatAnswer("a summary"));
    });
    try {
      const answer = await new SummaryModelClient().generate(config(), prompt);
      expect(answer).toBe("a summary");
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.url).toBe("https://summary.example.com/v1/chat/completions");
      expect(call?.method).toBe("POST");
      expect(call?.headers["content-type"]).toBe("application/json");
      expect(call?.headers["authorization"]).toBe("Bearer summary-secret");
      expect(call?.signal).toBeInstanceOf(AbortSignal);
      expect(call?.signal?.aborted).toBe(false);
      expect(call?.body).toBe(
        '{"model":"summary-model","temperature":0,"messages":[{"role":"system","content":"answer in JSON"},{"role":"user","content":"the prepared input"}],"stream":false,"reasoning_effort":"none"}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a responses request that carries the instruction with the input", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(new Response(JSON.stringify({ output_text: "a summary" })));
    });
    try {
      const answer = await new SummaryModelClient().generate(
        config({ api_type: "openai_responses" }),
        prompt,
      );
      expect(answer).toBe("a summary");
      const call = calls[0];
      expect(call?.url).toBe("https://summary.example.com/v1/responses");
      expect(call?.headers["authorization"]).toBe("Bearer summary-secret");
      expect(call?.body).toBe(
        '{"model":"summary-model","input":"answer in JSON\\n\\nthe prepared input","stream":false,"reasoning_effort":"none"}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends an Anthropic messages request with a version header", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(
        new Response(JSON.stringify({ content: [{ type: "text", text: "a summary" }] })),
      );
    });
    try {
      const answer = await new SummaryModelClient().generate(
        config({ api_type: "anthropic_messages" }),
        prompt,
      );
      expect(answer).toBe("a summary");
      const call = calls[0];
      expect(call?.url).toBe("https://summary.example.com/v1/messages");
      expect(call?.headers["x-api-key"]).toBe("summary-secret");
      expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(call?.headers["authorization"]).toBeUndefined();
      expect(call?.body).toBe(
        '{"model":"summary-model","max_tokens":2000,"system":"answer in JSON","messages":[{"role":"user","content":"the prepared input"}],"stream":false,"reasoning_effort":"none"}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps reasoning on when the configuration does not turn it off", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(chatAnswer("a summary"));
    });
    try {
      await new SummaryModelClient().generate(config({ disable_reasoning: false }), prompt);
      expect(calls[0]?.body).toBe(
        '{"model":"summary-model","temperature":0,"messages":[{"role":"system","content":"answer in JSON"},{"role":"user","content":"the prepared input"}],"stream":false}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends configured target headers over the protocol's own ones", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(chatAnswer("a summary"));
    });
    try {
      await new SummaryModelClient().generate(
        config({
          api_type: "anthropic_messages",
          target_headers: [" x-api-key : overridden ", "x-session: abc"],
        }),
        prompt,
      );
      expect(calls[0]?.headers["x-api-key"]).toBe("overridden");
      expect(calls[0]?.headers["x-session"]).toBe("abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks a target whose address already names the endpoint", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(chatAnswer("a summary"));
    });
    try {
      await new SummaryModelClient().generate(
        config({ target_url: "https://summary.example.com/v1/chat/completions" }),
        prompt,
      );
      expect(calls[0]?.url).toBe("https://summary.example.com/v1/chat/completions");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("arms the timeout the configuration asks for", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(chatAnswer("a summary"));
    });
    try {
      await new SummaryModelClient().generate(config({ timeout_ms: 40 }), prompt);
      const signal = calls[0]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      // The timeout is the client's own, not the caller's: it fires on its own and its
      // reason is the abort a timeout answers with.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason instanceof Error ? signal.reason.name : "").toBe("TimeoutError");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a rejected upstream status with the message it has always shown", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response('{"error":{"message":"key summary-secret is not allowed"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    try {
      const error = await new SummaryModelClient()
        .generate(config(), prompt)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "ApplicationError",
        code: "upstream_error",
        statusCode: 502,
        expose: true,
        message: "The summary model returned HTTP 401.",
        details: { phase: "summary_model_request", upstream_status: 401 },
      });
      // The upstream body must never be copied into the message the console shows.
      expect(error instanceof Error ? error.message : "").not.toContain("summary-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the original network failure behind a safe message", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("getaddrinfo summary-secret.example.com failed")),
    );
    try {
      const error = await new SummaryModelClient()
        .generate(config(), prompt)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "ApplicationError",
        code: "upstream_error",
        statusCode: 502,
        expose: true,
        message: "The summary model could not be reached.",
        details: {
          phase: "summary_model_request",
          target_host: "summary.example.com",
          target_path: "/v1/chat/completions",
        },
      });
      expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(TypeError);
      expect(error instanceof Error ? error.message : "").not.toContain("summary-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a timeout as an unreachable model and keeps the abort as its cause", async () => {
    // A real upstream that answers too slowly for the configured timeout: the
    // timeout is the abort this client knows, and it is the transport's own signal.
    const server = await listen((_request, response) => {
      setTimeout(() => response.end("late"), 2_000);
    });
    try {
      const error = await new SummaryModelClient()
        .generate(config({ target_url: urlFor(server), timeout_ms: 50 }), prompt)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "ApplicationError",
        code: "upstream_error",
        statusCode: 502,
        expose: true,
        message: "The summary model could not be reached.",
        details: {
          phase: "summary_model_request",
          target_host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
          target_path: "/chat/completions",
        },
      });
      const cause = error instanceof Error ? error.cause : undefined;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).name).toBe("TimeoutError");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((closeError) => (closeError ? reject(closeError) : resolve())),
      );
      const index = servers.indexOf(server);
      if (index >= 0) servers.splice(index, 1);
    }
  }, 20_000);

  it("refuses an answer that is larger than the model may return", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("x".repeat(2_000_001))));
    try {
      await expect(new SummaryModelClient().generate(config(), prompt)).rejects.toMatchObject({
        code: "upstream_error",
        statusCode: 502,
        message: "The summary model response is too large.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an answer that carries no text", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ choices: [{ message: {} }] }))),
    );
    try {
      await expect(new SummaryModelClient().generate(config(), prompt)).rejects.toMatchObject({
        code: "upstream_error",
        message: "The summary model returned an empty response.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a response body that is not JSON to fail as it always did", async () => {
    // The caller has to tell "the body was not JSON" apart from "the text was not
    // JSON", so this is not wrapped into the project's own error here.
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>gateway error</html>")));
    try {
      const error = await new SummaryModelClient()
        .generate(config(), prompt)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(ApplicationError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the answer out of each protocol's own envelope", async () => {
    const bodies: readonly string[] = [
      JSON.stringify({ choices: [{ message: { content: "from chat" } }] }),
      JSON.stringify({ output_text: "from responses text" }),
      JSON.stringify({
        output: [{ content: [{ text: "from " }, { text: "responses parts" }] }],
      }),
      JSON.stringify({ content: [{ type: "text", text: "from anthropic" }] }),
    ];
    for (const body of bodies) {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(body)));
      try {
        await expect(new SummaryModelClient().generate(config(), prompt)).resolves.toBeTruthy();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("reports a working connection with the status and a short answer", async () => {
    const upstreamAnswer = JSON.stringify({ ok: true, note: "y".repeat(700) });
    const server = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(upstreamAnswer);
    });
    try {
      const report = await new SummaryModelClient().testConnection(
        config({ target_url: urlFor(server) }),
      );
      expect(report).toEqual({
        ok: true,
        // The detail is the answer cut to what the dialog can show.
        detail: `HTTP 200: ${upstreamAnswer.slice(0, 500)}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((closeError) => (closeError ? reject(closeError) : resolve())),
      );
      const index = servers.indexOf(server);
      if (index >= 0) servers.splice(index, 1);
    }
  });

  it("passes the transport's own message through as the detail to show", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connect ECONNREFUSED 127.0.0.1:9")));
    try {
      const report = await new SummaryModelClient().testConnection(config());
      expect(report).toEqual({ ok: false, detail: "connect ECONNREFUSED 127.0.0.1:9" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an unanswered check as failed", async () => {
    // Port 9 is the discard port: nothing listens there.
    const report = await new SummaryModelClient().testConnection(
      config({ target_url: "http://127.0.0.1:9" }),
    );
    expect(report.ok).toBe(false);
    // A failed check is an ordinary answer, not the sentence a failed generation shows.
    expect(report.detail).not.toBe("");
    expect(report.detail).not.toBe("The summary model could not be reached.");
  });

  it("sends a one-word ping and no temperature for every protocol", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) => {
      recordCall(input, init, calls);
      return Promise.resolve(new Response("", { status: 204 }));
    });
    try {
      const client = new SummaryModelClient();
      const apiTypes = ["openai_chat", "openai_responses", "anthropic_messages"] as const;
      for (const apiType of apiTypes) {
        await client.testConnection(config({ api_type: apiType }));
      }
      const bodies = calls.map((call) => call.body);
      expect(bodies[0]).toBe(
        '{"model":"summary-model","messages":[{"role":"user","content":"ping"}],"stream":false,"reasoning_effort":"none"}',
      );
      expect(bodies[1]).toBe(
        '{"model":"summary-model","input":"ping","stream":false,"reasoning_effort":"none"}',
      );
      expect(bodies[2]).toBe(
        '{"model":"summary-model","max_tokens":1,"messages":[{"role":"user","content":"ping"}],"stream":false,"reasoning_effort":"none"}',
      );
      expect(calls.map((call) => call.url)).toEqual([
        "https://summary.example.com/v1/chat/completions",
        "https://summary.example.com/v1/responses",
        "https://summary.example.com/v1/messages",
      ]);
      expect(calls[0]?.headers["authorization"]).toBe("Bearer summary-secret");
      expect(calls[2]?.headers["x-api-key"]).toBe("summary-secret");
      expect(calls[2]?.headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a non-2xx check as a failed test with the status it saw", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("invalid api key", { status: 401 })));
    try {
      const report = await new SummaryModelClient().testConnection(config());
      expect(report).toEqual({ ok: false, detail: "HTTP 401: invalid api key" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a check whose upstream said nothing with just the status", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("   ", { status: 200 })));
    try {
      const report = await new SummaryModelClient().testConnection(config());
      expect(report).toEqual({ ok: true, detail: "HTTP 200" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
