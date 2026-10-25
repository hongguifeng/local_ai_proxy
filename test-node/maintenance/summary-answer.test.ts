import { describe, expect, it } from "vitest";

import {
  parseStoredBriefFacts,
  parseSummaryPayload,
  parseTaskBriefContent,
} from "../../src/maintenance/summary-answer.js";
import {
  TASK_BRIEF_FACT_LIMIT,
  TASK_BRIEF_TEXT_LIMIT,
} from "../../src/maintenance/summary-prompts.js";
import { ApplicationError } from "../../src/shared/index.js";

/**
 * [AI-11] The response-parsing boundary: what the summary model answered.
 *
 * A summary payload is the model's own JSON: it is stored and read back as it was
 * written, so the only thing this boundary refuses is the shape the prompt did not ask
 * for. A brief is prose that a strict-JSON model may still wrap in a paragraph, a fence
 * or quotes, so the paragraph has to survive all three. Both refusals are reported with
 * the message the console has always shown.
 */

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("The answer was accepted, but it should not have been.");
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

  it("reads a brief out of a JSON answer", () => {
    const parsed = parseTaskBriefContent(
      JSON.stringify({ brief: "在整理测试。", facts: { agent: "pi 0.39", "Git Branch": "main" } }),
    );
    expect(parsed.text).toBe("在整理测试。");
    expect(parsed.facts).toEqual({ agent: "pi 0.39", git_branch: "main" });
  });

  it("reads a brief out of a fenced answer and keeps its facts", () => {
    const fenced =
      "```json\n" +
      JSON.stringify({
        brief: "在整理仓库。",
        facts: {
          cwd: "/home/dev/repo",
          git_branch: false,
          too_long: "y".repeat(500),
          agent: null,
        },
      }) +
      "\n```";
    const parsed = parseTaskBriefContent(fenced);
    expect(parsed.text).toBe("在整理仓库。");
    // Only short strings survive: booleans, nulls and oversized values are cut down.
    expect(parsed.facts).toEqual({
      cwd: "/home/dev/repo",
      too_long: `${"y".repeat(200)}…`,
    });
  });

  it("keeps a prose answer as a brief and gives it no facts", () => {
    const parsed = parseTaskBriefContent(
      "这个任务在调试本地代理的流式转发。\n它先跑了测试，又改了日志。",
    );
    expect(parsed.text).toBe("这个任务在调试本地代理的流式转发。 它先跑了测试，又改了日志。");
    expect(parsed.facts).toEqual({});
  });

  it("unwraps a paragraph a model still put in a JSON object or in quotes", () => {
    expect(parseTaskBriefContent('{"brief":"一句话概述","rest":"ignored"}').text).toBe(
      "一句话概述",
    );
    expect(parseTaskBriefContent('"一句话概述"').text).toBe("一句话概述");
    expect(parseTaskBriefContent('{"text":"另一段。","facts":{}}').text).toBe("另一段。");
    expect(parseTaskBriefContent("```text\n一段话\n```").text).toBe("一段话");
    expect(parseTaskBriefContent("```json\nnot json at all\n```").text).toBe("not json at all");
  });

  it("keeps a paragraph to the length the card can show", () => {
    const parsed = parseTaskBriefContent(`{"brief":"${"a".repeat(TASK_BRIEF_TEXT_LIMIT + 10)}}"`);
    expect(parsed.text).toBe(`${"a".repeat(TASK_BRIEF_TEXT_LIMIT)}…`);
  });

  it("keeps as many facts as the card has room for", () => {
    const many = Object.fromEntries(
      Array.from({ length: TASK_BRIEF_FACT_LIMIT + 4 }, (_unused, index) => [
        `key-${index}`,
        `value-${index}`,
      ]),
    );
    const parsed = parseTaskBriefContent(JSON.stringify({ brief: "b", facts: many }));
    expect(Object.keys(parsed.facts)).toHaveLength(TASK_BRIEF_FACT_LIMIT);
    expect(Object.keys(parsed.facts)[0]).toBe("key_0");
  });

  it("normalizes a fact key and skips blank names and values", () => {
    const parsed = parseTaskBriefContent(
      JSON.stringify({
        brief: "b",
        facts: { " Git Branch ": "main", "": "blank", os: "  ", "a-b": "kept" },
      }),
    );
    expect(parsed.facts).toEqual({ git_branch: "main", a_b: "kept" });
  });

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

  it("reports a refused answer as an error the console may show", () => {
    expect(failureOf(() => parseSummaryPayload("nope"))).toBeInstanceOf(ApplicationError);
    expect(failureOf(() => parseSummaryPayload('{"segments":"not an array"}'))).toBeInstanceOf(
      ApplicationError,
    );
  });
});
