import { joinTargetPath, parseTargetUrl } from "./target.js";

/**
 * The request shape of the three upstream chat protocols this project speaks:
 * OpenAI chat completions, OpenAI responses and Anthropic messages.
 *
 * Connection checks and real model calls are built from the same four answers -
 * which path the protocol lives at, which headers authenticate it, which URL the
 * target's base path turns into, and how a prompt becomes a request body - while
 * each caller keeps its own business parameters: a check sends a one-word ping and
 * reads a few kilobytes back, a real call sends an instruction with a prepared
 * input and reads the model's whole answer.
 *
 * This is a leaf module: it depends on nothing but the target URL tools, so the
 * transport, the summary client and the admin assembly can all import the file
 * directly without pulling a transport runtime through the proxy barrel.
 */

/** One of the three upstream request protocols. */
export type UpstreamApiKind = "chat" | "responses" | "anthropic";

/** The version header the Anthropic messages API requires. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Where each protocol's completions endpoint lives under the target's base path. */
const ENDPOINT_BY_KIND: Readonly<Record<UpstreamApiKind, string>> = {
  chat: "/chat/completions",
  responses: "/responses",
  anthropic: "/messages",
};

/** The endpoint path of one protocol, relative to the target's base path. */
export function upstreamEndpointPath(kind: UpstreamApiKind): string {
  return ENDPOINT_BY_KIND[kind];
}

/**
 * The authentication headers of one protocol. `undefined` means the caller has no
 * credentials at all and sends none; an empty string is still a credential and is
 * sent as it stands, because a configured summary model may hold an empty key and
 * the upstream has to see the same header it saw before this module existed.
 */
export function upstreamAuthHeaders(
  kind: UpstreamApiKind,
  apiKey: string | undefined,
): Record<string, string> {
  if (kind === "anthropic") {
    return {
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
    };
  }
  return apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
}

/**
 * The absolute URL a target address turns a protocol's endpoint into. A base path
 * that already names the endpoint is used as it stands, so a target written as
 * `https://host/v1/messages` is asked at `/v1/messages` instead of
 * `/v1/messages/messages`; anything else is joined under the base path. The address
 * is validated first so an unusable one fails with the project's own message.
 */
export function resolveUpstreamUrl(targetUrl: string, kind: UpstreamApiKind): URL {
  // Validate the address before it is used: an unusable one has to fail with the
  // project's own message instead of whatever `new URL` or `fetch` decides to say.
  parseTargetUrl(targetUrl);
  const url = new URL(targetUrl);
  const endpoint = upstreamEndpointPath(kind);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = basePath.endsWith(endpoint) ? basePath : joinTargetPath(basePath, endpoint);
  return url;
}

/**
 * What a protocol request needs beyond the protocol itself: which model to ask, the
 * instruction the model is told to follow, the prepared text it must answer about,
 * and the two generation limits that differ between a connection check and a real
 * call. A missing `system` or limit means the protocol's own default is used.
 */
export interface UpstreamPromptBody {
  readonly model: string;
  /** The instruction the model must follow, or `undefined` when there is none. */
  readonly system: string | undefined;
  /** The text the model is asked about: the user turn, or the responses input. */
  readonly input: string;
  /** The answer length cap for the Anthropic protocol, which requires one. */
  readonly maxTokens: number | undefined;
  /** The sampling temperature for the chat protocol, or `undefined` to leave it out. */
  readonly temperature: number | undefined;
}

/**
 * The non-streaming request body of one protocol. The key order is part of the
 * stored shape: a summary model sees exactly the bytes the project has always sent
 * it, so the fields are written in the order the callers wrote them before this
 * module existed - model, then the generation limits, then the prompt, then `stream`.
 */
export function upstreamRequestBody(
  kind: UpstreamApiKind,
  prompt: UpstreamPromptBody,
): Record<string, unknown> {
  const { model, system, input, maxTokens, temperature } = prompt;
  const user = { role: "user", content: input };
  if (kind === "responses") {
    // The responses protocol has no system turn, so the instruction travels with
    // the input, separated by a blank line.
    return {
      model,
      input: system === undefined ? input : `${system}\n\n${input}`,
      stream: false,
    };
  }
  if (kind === "anthropic") {
    return {
      model,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(system === undefined ? {} : { system }),
      messages: [user],
      stream: false,
    };
  }
  return {
    model,
    ...(temperature === undefined ? {} : { temperature }),
    messages: [...(system === undefined ? [] : [{ role: "system", content: system }]), user],
    stream: false,
  };
}
