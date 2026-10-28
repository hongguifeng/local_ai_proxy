import type { SummaryModelConfig } from "../config/index.js";
import {
  resolveUpstreamUrl,
  upstreamAuthHeaders,
  upstreamRequestBody,
  type UpstreamApiKind,
} from "../proxy/api-request.js";
import { isRecord } from "../shared/index.js";
import { summaryModelFailure } from "./summary-failure.js";

/**
 * The summary model's transport. One object owns the URL, the header set, the timeout
 * and the response reading of all three protocols, so the generation service can ask
 * for an answer without building an upstream HTTP request itself. Protocol *shape* -
 * endpoint path, auth headers, URL and body - is shared with the connection checks in
 * `src/proxy/api-request.ts`; what stays here is what only a summary call needs: the
 * configured key and extra headers, the timeout from the configuration, the size cap on
 * the answer, and how a protocol's response envelope carries text.
 */

/** What a summary call asks the model to do, and what it is asked about. */
export interface SummaryModelPrompt {
  readonly instruction: string;
  readonly input: string;
}

/** The generation half of the summary model, as the generation service needs it. */
export interface SummaryModelGenerator {
  generate(config: SummaryModelConfig, prompt: SummaryModelPrompt): Promise<string>;
}

/** What a summary-model connection test found out. */
export interface SummaryModelConnectionReport {
  readonly ok: boolean;
  readonly detail: string;
}

const MAX_SUMMARY_RESPONSE_CHARS = 2_000_000;
// How much room the answer gets. A task brief is no longer capped in how many stages it
// may carry, so the answer has to be long enough to finish a long timeline: an answer cut
// off halfway through is refused as unparseable, and an answer that ran out of room before
// the last stage is not a result the card can show. This is an output ceiling, not a cost
// or timeout threshold, and it says nothing about when a call should be refused.
const SUMMARY_MAX_TOKENS = 4000;
const SUMMARY_TEMPERATURE = 0;
const CHECK_PROMPT = "ping";
const CHECK_MAX_TOKENS = 1;
const CHECK_DETAIL_CHARS = 500;

/** How the configuration names the three protocols, and what this module calls them. */
function apiKind(apiType: SummaryModelConfig["api_type"]): UpstreamApiKind {
  if (apiType === "openai_responses") return "responses";
  if (apiType === "anthropic_messages") return "anthropic";
  return "chat";
}

/**
 * The extra headers a summary model target carries, written as `Name: value` strings in
 * the configuration. They are merged last, so a configured header wins over a
 * protocol's own - which is what the console has always meant by an override.
 */
function targetHeaderOverrides(overrides: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    overrides.map((header) => {
      const separator = header.indexOf(":");
      return [header.slice(0, separator).trim(), header.slice(separator + 1).trim()];
    }),
  );
}

export class SummaryModelClient implements SummaryModelGenerator {
  /**
   * Ask the configured model for an answer and return its text. Every way a call can
   * fail is reported with the project's own error: an unreadable upstream, a rejected
   * status, an oversized answer and an answer that carries no text at all. A response
   * body that is not JSON is left to fail as it always did, because the caller has to
   * tell "the body was not JSON" apart from "the text was not JSON".
   */
  async generate(config: SummaryModelConfig, prompt: SummaryModelPrompt): Promise<string> {
    const kind = apiKind(config.api_type);
    const target = resolveUpstreamUrl(config.target_url, kind);
    const body = JSON.stringify(
      withReasoningDepth(
        upstreamRequestBody(kind, {
          model: config.model,
          system: prompt.instruction,
          input: prompt.input,
          maxTokens: SUMMARY_MAX_TOKENS,
          temperature: SUMMARY_TEMPERATURE,
        }),
        config.reasoning_effort,
      ),
    );
    let response: Response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...upstreamAuthHeaders(kind, config.api_key),
          ...targetHeaderOverrides(config.target_headers),
        },
        body,
        signal: AbortSignal.timeout(config.timeout_ms),
      });
    } catch (error) {
      // The cause can name a host or a DNS failure, so it stays in the internal log.
      throw summaryModelFailure("The summary model could not be reached.", error, {
        phase: "summary_model_request",
        target_host: target.host,
        target_path: target.pathname,
      });
    }
    if (!response.ok) {
      throw summaryModelFailure(`The summary model returned HTTP ${response.status}.`, undefined, {
        phase: "summary_model_request",
        upstream_status: response.status,
      });
    }
    const rawResponse = await response.text();
    if (rawResponse.length > MAX_SUMMARY_RESPONSE_CHARS) {
      throw summaryModelFailure("The summary model response is too large.");
    }
    const payload: Record<string, unknown> = JSON.parse(rawResponse) as Record<string, unknown>;
    const content = answerText(payload);
    if (!content) throw summaryModelFailure("The summary model returned an empty response.");
    return content;
  }

  /**
   * Ask the configured model a one-word question and report what came back. A failed
   * request is an ordinary answer here, not an error the console has to handle, so the
   * transport's own message is passed through as the detail to show.
   */
  async testConnection(config: SummaryModelConfig): Promise<SummaryModelConnectionReport> {
    const kind = apiKind(config.api_type);
    const target = resolveUpstreamUrl(config.target_url, kind);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...upstreamAuthHeaders(kind, config.api_key),
          ...targetHeaderOverrides(config.target_headers),
        },
        body: JSON.stringify(
          withReasoningDepth(
            upstreamRequestBody(kind, {
              model: config.model,
              system: undefined,
              input: CHECK_PROMPT,
              maxTokens: kind === "anthropic" ? CHECK_MAX_TOKENS : undefined,
              temperature: undefined,
            }),
            config.reasoning_effort,
          ),
        ),
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      const responseText = (await response.text()).trim().slice(0, CHECK_DETAIL_CHARS);
      return {
        ok: response.status >= 200 && response.status < 300,
        detail:
          responseText === ""
            ? `HTTP ${response.status}`
            : `HTTP ${response.status}: ${responseText}`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "request failed" };
    }
  }
}

/**
 * `reasoning_effort` is written last, which is where the project has always written it. It
 * is written only when the configuration names a depth: leaving the depth unset means the
 * provider decides, so the field stays out of the body instead of being sent empty, and a
 * depth that is set is sent verbatim - this module does not translate, clip or map it.
 */
function withReasoningDepth(
  body: Record<string, unknown>,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  return reasoningEffort === undefined ? body : { ...body, reasoning_effort: reasoningEffort };
}

/**
 * The text a protocol's response envelope carries. The three protocols put the answer
 * in different places, and a gateway may answer with a fourth shape, so all four are
 * read in the order the project has always read them: a chat choice, then the responses
 * text, then the responses output parts, then an Anthropic content block.
 */
function answerText(payload: Readonly<Record<string, unknown>>): string | undefined {
  const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
  const message =
    firstChoice && isRecord(firstChoice["message"]) ? firstChoice["message"] : undefined;
  return (
    (message && typeof message["content"] === "string" ? message["content"] : undefined) ??
    (typeof payload["output_text"] === "string" ? payload["output_text"] : undefined) ??
    responsesOutputText(payload["output"]) ??
    (Array.isArray(payload["content"]) &&
    isRecord(payload["content"][0]) &&
    typeof payload["content"][0]["text"] === "string"
      ? payload["content"][0]["text"]
      : undefined)
  );
}

function responsesOutputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item["content"])) continue;
    for (const content of item["content"]) {
      if (!isRecord(content)) continue;
      const text = content["text"];
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length ? parts.join("") : undefined;
}
