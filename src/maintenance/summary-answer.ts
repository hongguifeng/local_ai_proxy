import { isRecord } from "../shared/index.js";
import type { HistorySummary } from "./log-query-service.js";
import {
  TASK_BRIEF_FACT_LIMIT,
  TASK_BRIEF_FACT_VALUE_LIMIT,
  TASK_BRIEF_TEXT_LIMIT,
} from "./summary-prompts.js";
import { summaryModelFailure } from "./summary-failure.js";
import { truncateText } from "./text-limit.js";

/**
 * What the summary model answered. This boundary turns the model's raw text into the
 * two things the console stores - a record summary and a task brief with its
 * environment facts - and refuses only what the prompt did not ask for. It never
 * renames, normalizes or drops anything inside a summary payload: the payload is the
 * model's own JSON, kept verbatim, so keys this project does not name survive the
 * round trip.
 */

/**
 * The boundary between the summary model's raw text and the stored summary model. The
 * payload is kept exactly as the model wrote it - nothing is renamed, normalized or dropped -
 * so only the shape the prompt requires is checked here. A fenced block is accepted because
 * models that were told to emit strict JSON still wrap it.
 */
export function parseSummaryPayload(content: string): HistorySummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = /```json\s*([\s\S]*?)```/u.exec(content);
    const jsonText = match?.[1];
    if (jsonText === undefined)
      throw summaryModelFailure("The summary model returned text that is not JSON.");
    parsed = JSON.parse(jsonText);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["segments"]))
    throw summaryModelFailure("The summary model did not return the expected JSON shape.");
  return parsed;
}

/**
 * Read the brief model's answer: the summary paragraph plus the environment
 * facts it extracted. A model that ignores the JSON contract and answers with
 * prose still yields a brief, just without any facts.
 */
export function parseTaskBriefContent(content: string): {
  text: string;
  facts: Record<string, string>;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(content);
    if (fenced?.[1] === undefined) return { text: briefParagraph(content), facts: {} };
    try {
      payload = JSON.parse(fenced[1]);
    } catch {
      return { text: briefParagraph(content), facts: {} };
    }
  }
  if (!isRecord(payload)) return { text: briefParagraph(content), facts: {} };
  const brief = payload["brief"] ?? payload["text"];
  return {
    text: typeof brief === "string" ? briefParagraph(brief) : briefParagraph(content),
    facts: sanitizeBriefFacts(payload["facts"] ?? payload["context"]),
  };
}

/**
 * Read the environment facts back out of the column they were stored in. A malformed
 * or empty context is "no facts", which is how the card shows a brief made before
 * facts were kept at all.
 */
export function parseStoredBriefFacts(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const facts = sanitizeBriefFacts(parsed);
  return Object.keys(facts).length === 0 ? undefined : facts;
}

/**
 * Normalize the model's answer into a single paragraph: drop code fences, the
 * JSON wrapper a strict-JSON model may still emit, and fold line breaks into
 * spaces so the brief renders as one block of text.
 */
function briefParagraph(content: string): string {
  let text = content.trim();
  const fenced = /```(?:json|text)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  // A model that still wraps its answer in a JSON object or quotes: unwrap it
  // so the card shows plain prose.
  text = text
    .replace(/^\{ *"?brief"? *:/u, "")
    .replace(/"? *\}\s*$/u, "")
    .replace(/^"+|"+$/gu, "")
    .trim();
  text = text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return text.length > TASK_BRIEF_TEXT_LIMIT ? `${text.slice(0, TASK_BRIEF_TEXT_LIMIT)}…` : text;
}

/** Keep only short string facts, with normalized keys and a bounded count. */
function sanitizeBriefFacts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const facts: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    const name = key
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_");
    const text = item.trim();
    if (name === "" || text === "") continue;
    facts[name] = truncateText(text, TASK_BRIEF_FACT_VALUE_LIMIT);
    if (Object.keys(facts).length >= TASK_BRIEF_FACT_LIMIT) break;
  }
  return facts;
}
