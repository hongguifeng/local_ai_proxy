import { isRecord } from "../shared/index.js";
import type { HistorySummary } from "./log-query-service.js";
import type { TimelineEvent, TimelineEventKind } from "./summary-input.js";
import {
  TASK_BRIEF_FACT_LIMIT,
  TASK_BRIEF_FACT_VALUE_LIMIT,
  TASK_BRIEF_TEXT_LIMIT,
  TASK_TIMELINE_TEXT_LIMIT,
} from "./summary-prompts.js";
import { summaryModelFailure } from "./summary-failure.js";
import { truncateText } from "./text-limit.js";

/**
 * What the summary model answered. This boundary turns the model's raw text into the
 * things the console stores - a record summary, and a task execution timeline with its
 * overview, steps, gaps and environment facts - and refuses what the prompt did not ask
 * for. It never renames, normalizes or drops anything inside a record summary payload:
 * that payload is the model's own JSON, kept verbatim, so keys this project does not name
 * survive the round trip. A task timeline is the opposite: every field is checked against
 * the numbered events the model was sent, because an answer that cites evidence that was
 * never sent is not a timeline the console can show.
 */

/** How a timeline step says what it knows. */
export type TimelineBasis = "observed" | "inferred" | "unknown";

/** One stage of the execution timeline, citing the events it is based on. */
export interface TimelineStep {
  readonly order: number;
  readonly evidence: readonly number[];
  readonly operation: string;
  readonly purpose: string;
  readonly result: string;
  readonly basis: TimelineBasis;
}

/** What the log cannot answer, also citing its evidence. */
export interface TimelineGap {
  readonly evidence: readonly number[];
  readonly description: string;
}

/** The stored shape of one task's execution timeline. */
export interface TaskTimeline {
  readonly overview: string;
  readonly steps: readonly TimelineStep[];
  readonly gaps: readonly TimelineGap[];
}

/** The kinds an event may carry, read back from the cache. */
const TIMELINE_KINDS: readonly TimelineEventKind[] = [
  "user_message",
  "assistant_message",
  "system_message",
  "reasoning_summary",
  "tool_call",
  "tool_result",
  "other",
  "truncation_marker",
];

const TIMELINE_BASES: readonly TimelineBasis[] = ["observed", "inferred", "unknown"];

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
 * Read the execution-timeline answer: the overview, the steps, the gaps and the
 * environment facts. `eventCount` is how many numbered events were sent, so every citation
 * can be checked against them. A refusal is a refusal of the whole answer: nothing is
 * returned, so the caller keeps the cache it already had rather than showing a timeline
 * whose evidence does not line up.
 */
export function parseTaskTimelineAnswer(
  content: string,
  eventCount: number,
): {
  readonly overview: string;
  readonly timeline: TaskTimeline;
  readonly facts: Readonly<Record<string, string>>;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(content);
    if (fenced?.[1] === undefined)
      throw summaryModelFailure("The summary model returned text that is not JSON.");
    try {
      payload = JSON.parse(fenced[1]);
    } catch {
      throw summaryModelFailure("The summary model returned text that is not JSON.");
    }
  }
  if (!isRecord(payload))
    throw summaryModelFailure("The summary model did not return the expected JSON shape.");

  const overview = payload["overview"] ?? payload["brief"];
  if (typeof overview !== "string")
    throw summaryModelFailure("The summary model did not return the expected JSON shape.");
  const text = briefParagraph(overview);
  if (text === "") throw summaryModelFailure("The summary model returned an empty task overview.");

  const steps = readSteps(payload["steps"], eventCount);
  const gaps = readGaps(payload["gaps"], eventCount);
  return {
    overview: text,
    timeline: { overview: text, steps, gaps },
    facts: sanitizeBriefFacts(payload["facts"] ?? payload["context"]),
  };
}

/** Read and check the steps; a missing or empty list is not a timeline. There is no
 * cap on how many stages a timeline may carry - a long task gets a long card, and the
 * card scrolls - so only the shape of each step is refused here. */
function readSteps(value: unknown, eventCount: number): readonly TimelineStep[] {
  if (!Array.isArray(value))
    throw summaryModelFailure("The summary model did not return the expected JSON shape.");
  if (value.length === 0)
    throw summaryModelFailure("The summary model returned a timeline without any steps.");

  const steps: TimelineStep[] = [];
  let previousOrder = 0;
  for (const item of value) {
    if (!isRecord(item))
      throw summaryModelFailure("The summary model did not return the expected JSON shape.");
    const order = item["order"];
    if (typeof order !== "number" || !Number.isInteger(order) || order < 1)
      throw summaryModelFailure("The summary model returned a step without a usable order.");
    if (order <= previousOrder)
      throw summaryModelFailure("The summary model returned a step order that does not increase.");
    previousOrder = order;

    const basis = readBasis(item["basis"], order);
    const operation = requiredTextField(item["operation"], `step ${order}`, "operation");
    if (steps.length === 0 && order !== 1)
      throw summaryModelFailure("The summary model returned a timeline whose first step is not 1.");
    steps.push({
      order,
      evidence: readEvidence(item["evidence"], eventCount, `step ${order}`),
      operation,
      purpose: optionalStepField(item["purpose"], `step ${order}`, "purpose", basis),
      result: optionalStepField(item["result"], `step ${order}`, "result", basis),
      basis,
    });
  }
  return steps;
}

/** Read and check the gaps; an absent list is simply "no gaps were reported". The number
 * of gaps is not capped either: what a long task leaves unclear stays on the card. */
function readGaps(value: unknown, eventCount: number): readonly TimelineGap[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw summaryModelFailure("The summary model did not return the expected JSON shape.");

  const gaps: TimelineGap[] = [];
  for (const item of value) {
    if (!isRecord(item))
      throw summaryModelFailure("The summary model did not return the expected JSON shape.");
    const description = textField(item["description"], "gap");
    if (description === "")
      throw summaryModelFailure("The summary model returned a gap without a description.");
    gaps.push({ evidence: readEvidence(item["evidence"], eventCount, "gap"), description });
  }
  return gaps;
}

/**
 * The evidence numbers of one step or gap: integers, inside the range that was actually
 * sent, deduplicated and put back in event order. Sorting is not a correction of the
 * model's reasoning - it is the server refusing to show a citation list that reads
 * backwards from the events it points at. How many numbers a step cites is not capped:
 * a long task cites many events, and the chip row wraps instead of failing the answer.
 */
function readEvidence(value: unknown, eventCount: number, what: string): readonly number[] {
  if (!Array.isArray(value))
    throw summaryModelFailure(`The summary model returned ${what} without evidence.`);
  if (value.length === 0)
    throw summaryModelFailure(`The summary model returned ${what} without evidence.`);
  const numbers = new Set<number>();
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item))
      throw summaryModelFailure(`The summary model cited evidence that is not an event number.`);
    if (item < 1 || item > eventCount)
      throw summaryModelFailure(
        "The summary model cited an evidence number that was not sent to it.",
      );
    numbers.add(item);
  }
  return [...numbers].sort((left, right) => left - right);
}

function readBasis(value: unknown, order: number): TimelineBasis {
  if (typeof value !== "string" || !TIMELINE_BASES.includes(value as TimelineBasis))
    throw summaryModelFailure(
      `The summary model returned a basis that is not observed, inferred or unknown (step ${order}).`,
    );
  return value as TimelineBasis;
}

/** How English puts "a" or "an" in front of one of these field names. */
function indefinite(field: string): string {
  return /^[aeiou]/i.test(field) ? "an" : "a";
}

/** A field the answer has to fill in: an empty one is not an answer about anything. */
function requiredTextField(value: unknown, what: string, field: string): string {
  if (value === undefined || value === null)
    throw summaryModelFailure(
      `The summary model returned ${what} without ${indefinite(field)} ${field}.`,
    );
  if (typeof value !== "string")
    throw summaryModelFailure(
      `The summary model wrote the ${field} of ${what} as something other than text.`,
    );
  const text = truncateText(value.trim(), TASK_TIMELINE_TEXT_LIMIT);
  if (text === "")
    throw summaryModelFailure(
      `The summary model returned ${what} without ${indefinite(field)} ${field}.`,
    );
  return text;
}

/**
 * A step's purpose and result. `basis: unknown` is the model saying the log does not tell
 * it, so such a step may leave either field empty instead of making one up; any other step
 * has to say what it was for and what came of it. An empty string here is a stored "the log
 * does not say", and the UI renders no line for it.
 */
function optionalStepField(
  value: unknown,
  what: string,
  field: string,
  basis: TimelineBasis,
): string {
  if (value === undefined || value === null || value === "") {
    if (basis === "unknown") return "";
    throw summaryModelFailure(
      `The summary model returned ${what} without ${indefinite(field)} ${field}.`,
    );
  }
  if (typeof value !== "string")
    throw summaryModelFailure(
      `The summary model wrote the ${field} of ${what} as something other than text.`,
    );
  const text = truncateText(value.trim(), TASK_TIMELINE_TEXT_LIMIT);
  if (text === "" && basis !== "unknown")
    throw summaryModelFailure(
      `The summary model returned ${what} without ${indefinite(field)} ${field}.`,
    );
  return text;
}

function textField(value: unknown, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw summaryModelFailure(`The summary model wrote ${what} as something other than text.`);
  return truncateText(value.trim(), TASK_TIMELINE_TEXT_LIMIT);
}

/**
 * Read the timeline back out of the column it was stored in. Anything unreadable is "no
 * timeline", which is how the card shows a brief made before timelines were kept at all:
 * the overview paragraph is still there, and the user is told to regenerate for the steps.
 */
export function parseStoredTaskTimeline(value: unknown): TaskTimeline | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["steps"])) return undefined;
  const steps: TimelineStep[] = [];
  for (const item of parsed["steps"]) {
    if (!isRecord(item) || !Array.isArray(item["evidence"])) return undefined;
    const basis = item["basis"];
    if (typeof basis !== "string" || !TIMELINE_BASES.includes(basis as TimelineBasis))
      return undefined;
    steps.push({
      order: numberOrZero(item["order"]),
      evidence: item["evidence"].filter(isInteger).map((item) => item as number),
      operation: textOrEmpty(item["operation"]),
      purpose: textOrEmpty(item["purpose"]),
      result: textOrEmpty(item["result"]),
      basis: basis as TimelineBasis,
    });
  }
  const gaps: TimelineGap[] = Array.isArray(parsed["gaps"])
    ? parsed["gaps"].flatMap((item) => {
        if (!isRecord(item) || !Array.isArray(item["evidence"])) return [];
        return [
          {
            evidence: item["evidence"].filter(isInteger).map((item) => item as number),
            description: textOrEmpty(item["description"]),
          },
        ];
      })
    : [];
  return {
    overview: textOrEmpty(parsed["overview"]),
    steps,
    gaps,
  };
}

/**
 * Read the evidence events back out of the column they were stored in. They are the
 * server's own normalized events, so a row that does not decode is reported as absent
 * rather than half-shown: the console falls back to the overview alone.
 */
export function parseStoredTimelineEvents(value: unknown): readonly TimelineEvent[] | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const events: TimelineEvent[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || !isInteger(item["event_no"])) return undefined;
    const kind = item["kind"];
    if (typeof kind !== "string" || !TIMELINE_KINDS.includes(kind as TimelineEventKind))
      return undefined;
    const event: TimelineEvent = {
      event_no: item["event_no"] as number,
      kind: kind as TimelineEventKind,
      ...(typeof item["role"] === "string" ? { role: item["role"] } : {}),
      ...(typeof item["text"] === "string" ? { text: item["text"] } : {}),
      ...(typeof item["tool"] === "string" ? { tool: item["tool"] } : {}),
      ...(typeof item["arguments_preview"] === "string"
        ? { arguments_preview: item["arguments_preview"] }
        : {}),
      ...(typeof item["result_preview"] === "string"
        ? { result_preview: item["result_preview"] }
        : {}),
      ...(typeof item["call_id"] === "string" ? { call_id: item["call_id"] } : {}),
      ...(typeof item["operation_id"] === "string" ? { operation_id: item["operation_id"] } : {}),
      ...(isInteger(item["call_event_no"])
        ? { call_event_no: item["call_event_no"] as number }
        : {}),
      ...(isInteger(item["result_event_no"])
        ? { result_event_no: item["result_event_no"] as number }
        : {}),
      ...(item["unpaired"] === true ? { unpaired: true } : {}),
    };
    events.push(event);
  }
  return events;
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
 * Normalize the overview into a single paragraph: drop code fences, the JSON wrapper a
 * strict-JSON model may still emit, and fold line breaks into spaces so the card renders
 * it as one block of text.
 */
function briefParagraph(content: string): string {
  let text = content.trim();
  const fenced = /```(?:json|text)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  // A model that still wraps its answer in a JSON object or quotes: unwrap it
  // so the card shows plain prose.
  text = text
    .replace(/^\{ *"?overview"? *:/u, "")
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

function isInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function numberOrZero(value: unknown): number {
  return isInteger(value) ? (value as number) : 0;
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
