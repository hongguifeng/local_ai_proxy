import { describe, expect, it } from "vitest";

import {
  parseStoredBriefFacts,
  parseStoredTaskTimeline,
  parseStoredTimelineEvents,
  parseSummaryPayload,
  parseTaskTimelineAnswer,
} from "../../src/maintenance/summary-answer.js";
import {
  TASK_BRIEF_FACT_LIMIT,
  TASK_BRIEF_TEXT_LIMIT,
  TASK_TIMELINE_TEXT_LIMIT,
} from "../../src/maintenance/summary-prompts.js";
import { ApplicationError } from "../../src/shared/index.js";

/**
 * [AI-11] The response-parsing boundary: what the summary model answered.
 *
 * A summary payload is the model's own JSON: it is stored and read back as it was
 * written, so the only thing this boundary refuses is the shape the prompt did not ask
 * for. A task timeline is the opposite: every citation is checked against the numbered
 * events the model was actually sent, and a refusal throws away the whole answer so the
 * stored cache stays the one that was already checked.
 */

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("The answer was accepted, but it should not have been.");
}

/** A whole, valid answer over four numbered events, as the model would write it. */
function validAnswer(): string {
  return JSON.stringify({
    overview: "Debugging the loader, then checking it.",
    steps: [
      {
        order: 1,
        evidence: [1, 2],
        operation: "Read the loader",
        purpose: "Confirm path resolution",
        result: "Found a mismatch",
        basis: "observed",
      },
      {
        order: 2,
        evidence: [3, 4],
        operation: "Ran the test",
        purpose: "Check the fix",
        result: "Tests pass",
        basis: "inferred",
      },
    ],
    gaps: [{ evidence: [4], description: "The log does not say what happened next." }],
    facts: { agent: "pi 0.39", "Git Branch": "main" },
  });
}

describe("summary answer", () => {
  it("keeps the model's payload verbatim, including keys this project never named", () => {
    const modelPayload = {
      title: "Build stages",
      overview: "Two stages.",
      segments: [{ range: "1-6", summary: "install", key_points: [], evidence: [1, 6] }],
      decisions: ["keep the image"],
      issues: [],
      model_note: "written by the model",
      stage_count: 3,
    };
    expect(parseSummaryPayload(JSON.stringify(modelPayload))).toEqual(modelPayload);
  });

  it("accepts a JSON object wrapped in a fence", () => {
    const parsed = parseSummaryPayload(
      '```json\n{"title":"t","overview":"o","segments":[],"decisions":[],"issues":[]}\n```',
    );
    expect(parsed.segments).toEqual([]);
    expect(parsed.title).toBe("t");
  });

  it("refuses an answer that is not JSON", () => {
    const error = failureOf(() => parseSummaryPayload("plain prose"));
    expect(error).toMatchObject({
      name: "ApplicationError",
      code: "upstream_error",
      statusCode: 502,
      expose: true,
      message: "The summary model returned text that is not JSON.",
    });
  });

  it("refuses an answer without stage segments and stores nothing about it", () => {
    const error = failureOf(() => parseSummaryPayload('{"overview":"x"}'));
    expect(error).toMatchObject({
      code: "upstream_error",
      message: "The summary model did not return the expected JSON shape.",
    });
    expect(failureOf(() => parseSummaryPayload('["a","b"]'))).toMatchObject({
      message: "The summary model did not return the expected JSON shape.",
    });
  });

  it("reports a refused answer as an error the console may show", () => {
    expect(failureOf(() => parseSummaryPayload("nope"))).toBeInstanceOf(ApplicationError);
    expect(failureOf(() => parseSummaryPayload('{"segments":"not an array"}'))).toBeInstanceOf(
      ApplicationError,
    );
  });
});

describe("task timeline answer", () => {
  it("reads a whole timeline answer and keeps the facts it extracted", () => {
    const parsed = parseTaskTimelineAnswer(validAnswer(), 4);
    expect(parsed.overview).toBe("Debugging the loader, then checking it.");
    expect(parsed.timeline.steps.map((step) => step.order)).toEqual([1, 2]);
    expect(parsed.timeline.steps[0]?.evidence).toEqual([1, 2]);
    expect(parsed.timeline.steps[1]?.basis).toBe("inferred");
    expect(parsed.timeline.gaps).toEqual([
      { evidence: [4], description: "The log does not say what happened next." },
    ]);
    expect(parsed.facts).toEqual({ agent: "pi 0.39", git_branch: "main" });
    // The stored timeline carries the same overview the card shows as its paragraph.
    expect(parsed.timeline.overview).toBe(parsed.overview);
  });

  it("accepts a timeline wrapped in a json fence", () => {
    const fenced = "```json\n" + validAnswer() + "\n```";
    expect(parseTaskTimelineAnswer(fenced, 4).timeline.steps).toHaveLength(2);
  });

  it("accepts an answer with no gaps and reports none", () => {
    const withoutGaps = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "unknown" },
      ],
    });
    expect(parseTaskTimelineAnswer(withoutGaps, 1).timeline.gaps).toEqual([]);
  });

  it("puts cited evidence back in event order and drops duplicates", () => {
    const answer = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: [7, 2, 7, 5],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "observed",
        },
      ],
    });
    expect(parseTaskTimelineAnswer(answer, 8).timeline.steps[0]?.evidence).toEqual([2, 5, 7]);
  });

  it("refuses prose: a model that answers without a timeline produces nothing", () => {
    const error = failureOf(() => parseTaskTimelineAnswer("这个任务在调试代理。", 4));
    expect(error).toMatchObject({
      code: "upstream_error",
      statusCode: 502,
      message: "The summary model returned text that is not JSON.",
    });
  });

  it("refuses the old brief answer shape, so an old cache is not overwritten by it", () => {
    const error = failureOf(() =>
      parseTaskTimelineAnswer(JSON.stringify({ brief: "一段概述。", facts: {} }), 4),
    );
    expect(error).toMatchObject({
      code: "upstream_error",
      message: "The summary model did not return the expected JSON shape.",
    });
  });

  it("refuses an answer whose steps are missing or empty", () => {
    expect(
      failureOf(() => parseTaskTimelineAnswer(JSON.stringify({ overview: "o" }), 4)),
    ).toMatchObject({
      message: "The summary model did not return the expected JSON shape.",
    });
    expect(
      failureOf(() => parseTaskTimelineAnswer(JSON.stringify({ overview: "o", steps: [] }), 4)),
    ).toMatchObject({
      message: "The summary model returned a timeline without any steps.",
    });
  });

  it("refuses evidence that was never sent", () => {
    const outside = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [5], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(outside, 4))).toMatchObject({
      code: "upstream_error",
      message: "The summary model cited an evidence number that was not sent to it.",
    });
    const zero = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [0], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(zero, 4))).toMatchObject({
      message: "The summary model cited an evidence number that was not sent to it.",
    });
    const notANumber = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: ["1"],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "observed",
        },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(notANumber, 4))).toMatchObject({
      message: "The summary model cited evidence that is not an event number.",
    });
  });

  it("refuses a step with no evidence", () => {
    const answer = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(answer, 4))).toMatchObject({
      message: "The summary model returned step 1 without evidence.",
    });
    const missing = JSON.stringify({
      overview: "o",
      steps: [{ order: 1, operation: "a", purpose: "b", result: "c", basis: "observed" }],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(missing, 4))).toMatchObject({
      message: "The summary model returned step 1 without evidence.",
    });
  });

  it("refuses a step order that does not start at one or increase", () => {
    const firstNotOne = JSON.stringify({
      overview: "o",
      steps: [
        { order: 2, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(firstNotOne, 4))).toMatchObject({
      message: "The summary model returned a timeline whose first step is not 1.",
    });
    const duplicate = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(duplicate, 4))).toMatchObject({
      message: "The summary model returned a step order that does not increase.",
    });
    const notANumber = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: "1",
          evidence: [1],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "observed",
        },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(notANumber, 4))).toMatchObject({
      message: "The summary model returned a step without a usable order.",
    });
  });

  it("refuses a step that omits its purpose or result", () => {
    for (const field of ["purpose", "result"] as const) {
      const step: Record<string, unknown> = {
        order: 1,
        evidence: [1],
        operation: "a",
        purpose: "b",
        result: "c",
        basis: "observed",
      };
      const missingFieldStep = Object.fromEntries(
        Object.entries(step).filter(([key]) => key !== field),
      );
      expect(
        failureOf(() =>
          parseTaskTimelineAnswer(JSON.stringify({ overview: "o", steps: [missingFieldStep] }), 1),
        ),
      ).toMatchObject({
        message: `The summary model returned step 1 without a ${field}.`,
      });
    }
  });
  it("lets an unknown step leave its purpose or result empty", () => {
    // `basis: unknown` is the model saying the log does not tell it. Such a step may
    // leave either field blank instead of inventing one; the card renders no line for a
    // blank field, so the blank stays a "the log does not say" rather than a claim.
    for (const field of ["purpose", "result"] as const) {
      const step: Record<string, unknown> = {
        order: 1,
        evidence: [1],
        operation: "a",
        purpose: "b",
        result: "c",
        basis: "unknown",
      };
      const stepWithout = Object.fromEntries(Object.entries(step).filter(([key]) => key !== field));
      const accepted = parseTaskTimelineAnswer(
        JSON.stringify({ overview: "o", steps: [stepWithout] }),
        1,
      );
      expect(accepted.timeline.steps[0]?.[field]).toBe("");
      expect(accepted.timeline.steps[0]?.basis).toBe("unknown");
    }
    // The same blank on an observed step is still refused: an observed step claims the
    // log says it, so it has to say what it was for and what came of it.
    const observedBlank = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "  ", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(observedBlank, 1))).toMatchObject({
      message: "The summary model returned step 1 without a result.",
    });
  });

  it("refuses a basis that is not one of the three the prompt allows", () => {
    const answer = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: [1],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "certain",
        },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(answer, 4))).toMatchObject({
      code: "upstream_error",
      message:
        "The summary model returned a basis that is not observed, inferred or unknown (step 1).",
    });
  });

  it("refuses a step that names no operation", () => {
    const answer = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "  ", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(answer, 4))).toMatchObject({
      message: "The summary model returned step 1 without an operation.",
    });
  });

  it("refuses a gap that cites nothing or cites the wrong number", () => {
    const noEvidence = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
      gaps: [{ evidence: [], description: "x" }],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(noEvidence, 4))).toMatchObject({
      message: "The summary model returned gap without evidence.",
    });
    const outOfRange = JSON.stringify({
      overview: "o",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
      gaps: [{ evidence: [9], description: "x" }],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(outOfRange, 4))).toMatchObject({
      message: "The summary model cited an evidence number that was not sent to it.",
    });
  });

  it("keeps an overview the model still wrapped in a JSON object or in quotes", () => {
    const answer = JSON.stringify({
      overview: "  一句话概述  ",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(parseTaskTimelineAnswer(answer, 1).overview).toBe("一句话概述");
  });

  it("folds a multi-line overview into one paragraph", () => {
    const answer = JSON.stringify({
      overview: "第一段。\n第二段。",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(parseTaskTimelineAnswer(answer, 1).overview).toBe("第一段。 第二段。");
  });

  it("keeps an overview to the length the card can show", () => {
    const answer = JSON.stringify({
      overview: "a".repeat(TASK_BRIEF_TEXT_LIMIT + 10),
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(parseTaskTimelineAnswer(answer, 1).overview).toBe(
      `${"a".repeat(TASK_BRIEF_TEXT_LIMIT)}…`,
    );
  });

  it("refuses an empty overview", () => {
    const answer = JSON.stringify({
      overview: "   ",
      steps: [
        { order: 1, evidence: [1], operation: "a", purpose: "b", result: "c", basis: "observed" },
      ],
    });
    expect(failureOf(() => parseTaskTimelineAnswer(answer, 1))).toMatchObject({
      message: "The summary model returned an empty task overview.",
    });
  });

  it("keeps step text to the length the card has room for", () => {
    const answer = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: [1],
          operation: "d".repeat(TASK_TIMELINE_TEXT_LIMIT + 40),
          purpose: "p",
          result: "r",
          basis: "observed",
        },
      ],
    });
    expect(parseTaskTimelineAnswer(answer, 1).timeline.steps[0]?.operation).toBe(
      `${"d".repeat(TASK_TIMELINE_TEXT_LIMIT)}…`,
    );
  });

  it("keeps a long timeline whole: nothing is dropped for being long", () => {
    // A long task produces a long timeline. No stage, evidence number or gap is cut off
    // for overflowing a card budget: every citation and every stage survives, so the
    // card says all the log can be read, and the refusal list stays about whether an
    // answer cites something that was actually sent.
    const long = JSON.stringify({
      overview: "o",
      steps: Array.from({ length: 40 }, (_unused, index) => ({
        order: index + 1,
        evidence: Array.from({ length: 25 }, (_number, number) => number + 1),
        operation: "a",
        purpose: "b",
        result: "c",
        basis: "observed",
      })),
      gaps: Array.from({ length: 30 }, (_unused, index) => ({
        evidence: [1],
        description: `gap ${index + 1}`,
      })),
    });
    const parsed = parseTaskTimelineAnswer(long, 25);
    expect(parsed.timeline.steps).toHaveLength(40);
    expect(parsed.timeline.steps[39]?.evidence).toHaveLength(25);
    expect(parsed.timeline.gaps).toHaveLength(30);
    // A stored answer of the same length reads back whole too.
    expect(parseStoredTaskTimeline(JSON.stringify(parsed.timeline))?.steps).toHaveLength(40);
  });

  it("reads a stored timeline back, and treats anything unreadable as no timeline", () => {
    const stored = JSON.stringify({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: [2, 3],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "inferred",
        },
      ],
      gaps: [{ evidence: [3], description: "d" }],
    });
    expect(parseStoredTaskTimeline(stored)).toEqual({
      overview: "o",
      steps: [
        {
          order: 1,
          evidence: [2, 3],
          operation: "a",
          purpose: "b",
          result: "c",
          basis: "inferred",
        },
      ],
      gaps: [{ evidence: [3], description: "d" }],
    });
    // A brief written before timelines existed: the column is null, so there is no timeline.
    expect(parseStoredTaskTimeline(null)).toBeUndefined();
    expect(parseStoredTaskTimeline("")).toBeUndefined();
    expect(parseStoredTaskTimeline("not json")).toBeUndefined();
    expect(parseStoredTaskTimeline('{"overview":"o"}')).toBeUndefined();
    expect(parseStoredTaskTimeline('{"overview":"o","steps":"not an array"}')).toBeUndefined();
    expect(
      parseStoredTaskTimeline(
        '{"overview":"o","steps":[{"order":1,"evidence":[1],"basis":"guessed"}]}',
      ),
    ).toBeUndefined();
  });

  it("reads stored evidence events back, and drops a list that does not decode", () => {
    const stored = JSON.stringify([
      { event_no: 1, kind: "user_message", role: "user", text: "go" },
      {
        event_no: 2,
        kind: "tool_call",
        call_id: "c",
        tool: "read",
        arguments_preview: "{}",
        operation_id: "op-2",
        result_event_no: 3,
      },
      { event_no: 3, kind: "tool_result", call_id: "c", call_event_no: 2, unpaired: false },
      { event_no: 4, kind: "truncation_marker", text: "t" },
    ]);
    const events = parseStoredTimelineEvents(stored);
    expect(events).toHaveLength(4);
    expect(events?.[1]?.result_event_no).toBe(3);
    // `unpaired: false` says nothing, so it is not carried; only a real `true` is.
    expect(events?.[2]?.unpaired).toBeUndefined();
    expect(events?.[3]?.kind).toBe("truncation_marker");
    expect(parseStoredTimelineEvents(null)).toBeUndefined();
    expect(parseStoredTimelineEvents("not json")).toBeUndefined();
    expect(parseStoredTimelineEvents("[]")).toEqual([]);
    expect(parseStoredTimelineEvents('[{"kind":"user_message"}]')).toBeUndefined();
    expect(parseStoredTimelineEvents('[{"event_no":1,"kind":"made_up_kind"}]')).toBeUndefined();
  });
});

describe("stored brief facts", () => {
  it("reads stored facts back, and treats anything unreadable as no facts", () => {
    expect(parseStoredBriefFacts('{"cwd":"/repo","agent":"pi"}')).toEqual({
      cwd: "/repo",
      agent: "pi",
    });
    expect(parseStoredBriefFacts("not json")).toBeUndefined();
    expect(parseStoredBriefFacts("")).toBeUndefined();
    expect(parseStoredBriefFacts(null)).toBeUndefined();
    expect(parseStoredBriefFacts(7)).toBeUndefined();
    expect(parseStoredBriefFacts('{"n":1}')).toBeUndefined();
  });

  it("keeps as many facts as the card has room for", () => {
    const stored = Object.fromEntries(
      Array.from({ length: TASK_BRIEF_FACT_LIMIT + 4 }, (_unused, index) => [
        `key-${index}`,
        `value-${index}`,
      ]),
    );
    const facts = parseStoredBriefFacts(JSON.stringify(stored));
    expect(Object.keys(facts ?? {})).toHaveLength(TASK_BRIEF_FACT_LIMIT);
    expect(Object.keys(facts ?? {})[0]).toBe("key_0");
  });

  it("normalizes a fact key and skips blank names and values", () => {
    expect(
      parseStoredBriefFacts('{" Git Branch ":"main","":"blank","os":"  ","a-b":"kept"}'),
    ).toEqual({ git_branch: "main", a_b: "kept" });
  });
});
