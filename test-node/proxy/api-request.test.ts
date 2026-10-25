import { describe, expect, it } from "vitest";

import {
  resolveUpstreamUrl,
  upstreamAuthHeaders,
  upstreamEndpointPath,
  upstreamRequestBody,
  type UpstreamPromptBody,
} from "../../src/proxy/api-request.js";

/**
 * [AI-11] The protocol construction that connection checks and real model calls share.
 *
 * Three things are pinned here: the answer each protocol needs to be asked at all
 * (endpoint path, auth headers, URL), and the one place a prompt becomes a body. The
 * byte order of a body matters because a summary model has always seen the same
 * serialized request, so the key order is asserted as text and not only as an object.
 */

const prompt: UpstreamPromptBody = {
  model: "summary-model",
  system: "be brief",
  input: "the prepared input",
  maxTokens: 2000,
  temperature: 0,
};

describe("protocol construction shared by checks and calls", () => {
  it("names the endpoint each protocol lives at", () => {
    expect(upstreamEndpointPath("chat")).toBe("/chat/completions");
    expect(upstreamEndpointPath("responses")).toBe("/responses");
    expect(upstreamEndpointPath("anthropic")).toBe("/messages");
  });

  it("sends a bearer key for the two OpenAI protocols", () => {
    expect(upstreamAuthHeaders("chat", "sk-test")).toEqual({ authorization: "Bearer sk-test" });
    expect(upstreamAuthHeaders("responses", "sk-test")).toEqual({
      authorization: "Bearer sk-test",
    });
  });

  it("sends an api key and a version for the Anthropic protocol", () => {
    expect(upstreamAuthHeaders("anthropic", "sk-ant")).toEqual({
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant",
    });
  });

  it("sends the version but no key when there are no credentials", () => {
    expect(upstreamAuthHeaders("chat", undefined)).toEqual({});
    expect(upstreamAuthHeaders("responses", undefined)).toEqual({});
    expect(upstreamAuthHeaders("anthropic", undefined)).toEqual({
      "anthropic-version": "2023-06-01",
    });
  });

  it("sends a blank key as a credential when the caller has one", () => {
    // A configured summary model may hold an empty key. The upstream saw a header
    // before this module existed, so it still sees one.
    expect(upstreamAuthHeaders("chat", "")).toEqual({ authorization: "Bearer " });
    expect(upstreamAuthHeaders("anthropic", "")).toEqual({
      "anthropic-version": "2023-06-01",
      "x-api-key": "",
    });
  });

  it("joins a protocol under the target's base path", () => {
    expect(resolveUpstreamUrl("http://127.0.0.1:8080/v1", "chat").pathname).toBe(
      "/v1/chat/completions",
    );
    expect(resolveUpstreamUrl("https://host.example", "responses").pathname).toBe("/responses");
    expect(resolveUpstreamUrl("https://host.example/v1/", "anthropic").pathname).toBe(
      "/v1/messages",
    );
  });

  it("keeps a base path that already names the endpoint", () => {
    expect(resolveUpstreamUrl("https://host.example/v1/messages", "anthropic").pathname).toBe(
      "/v1/messages",
    );
    expect(resolveUpstreamUrl("https://host.example/v1/chat/completions", "chat").pathname).toBe(
      "/v1/chat/completions",
    );
  });

  it("keeps the address as written, including its scheme and port", () => {
    expect(resolveUpstreamUrl("https://host.example:8443/v1", "chat").toString()).toBe(
      "https://host.example:8443/v1/chat/completions",
    );
    // A default port is not written into the URL by either caller.
    expect(resolveUpstreamUrl("https://host.example/v1", "chat").host).toBe("host.example");
  });

  it("refuses an address that is not a plain http(s) host", () => {
    expect(() => resolveUpstreamUrl("not a url", "chat")).toThrow(TypeError);
    expect(() => resolveUpstreamUrl("not a url", "chat")).toThrow(
      "target_url must look like http://host[:port][/base-path] or https://host[:port][/base-path].",
    );
    expect(() => resolveUpstreamUrl("ftp://host.example/v1", "responses")).toThrow(TypeError);
  });

  it("writes the chat protocol body with a system turn before the user turn", () => {
    const body = upstreamRequestBody("chat", prompt);
    expect(JSON.stringify(body)).toBe(
      '{"model":"summary-model","temperature":0,"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"the prepared input"}],"stream":false}',
    );
  });

  it("writes the Anthropic body with a token cap and a system block", () => {
    const body = upstreamRequestBody("anthropic", prompt);
    expect(JSON.stringify(body)).toBe(
      '{"model":"summary-model","max_tokens":2000,"system":"be brief","messages":[{"role":"user","content":"the prepared input"}],"stream":false}',
    );
  });

  it("carries the instruction inside the responses input", () => {
    const body = upstreamRequestBody("responses", prompt);
    expect(JSON.stringify(body)).toBe(
      '{"model":"summary-model","input":"be brief\\n\\nthe prepared input","stream":false}',
    );
  });

  it("leaves out the fields a caller did not ask for", () => {
    const ping: UpstreamPromptBody = {
      model: "summary-model",
      system: undefined,
      input: "ping",
      maxTokens: undefined,
      temperature: undefined,
    };
    expect(JSON.stringify(upstreamRequestBody("chat", ping))).toBe(
      '{"model":"summary-model","messages":[{"role":"user","content":"ping"}],"stream":false}',
    );
    expect(JSON.stringify(upstreamRequestBody("anthropic", ping))).toBe(
      '{"model":"summary-model","messages":[{"role":"user","content":"ping"}],"stream":false}',
    );
    expect(JSON.stringify(upstreamRequestBody("responses", ping))).toBe(
      '{"model":"summary-model","input":"ping","stream":false}',
    );
    // The Anthropic protocol needs a cap: a caller that gives one gets it back.
    expect(JSON.stringify(upstreamRequestBody("anthropic", { ...ping, maxTokens: 1 }))).toBe(
      '{"model":"summary-model","max_tokens":1,"messages":[{"role":"user","content":"ping"}],"stream":false}',
    );
  });
});
