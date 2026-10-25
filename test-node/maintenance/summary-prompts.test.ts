import { describe, expect, it } from "vitest";

import {
  parseSummaryPayload,
  parseTaskBriefContent,
} from "../../src/maintenance/summary-answer.js";
import {
  SUMMARY_INSTRUCTION,
  SUMMARY_PROMPT_VERSION,
  TASK_BRIEF_FACT_LIMIT,
  TASK_BRIEF_FACT_VALUE_LIMIT,
  TASK_BRIEF_INSTRUCTION,
  TASK_BRIEF_PROMPT_VERSION,
} from "../../src/maintenance/summary-prompts.js";

/**
 * [AI-11] The prompting boundary: the instruction the model is given, and the version
 * stored beside the answer.
 *
 * The prompt version is the only thing that says which instruction produced a stored
 * text, so both versions and both instructions are pinned here as the exact values the
 * generation service writes and reads. What each instruction asks for is pinned against
 * the parser that refuses anything else: the two halves have to keep agreeing.
 */

describe("summary prompts", () => {
  it("records the version a stored summary carries", () => {
    expect(SUMMARY_PROMPT_VERSION).toBe("v1");
  });

  it("records the version a stored task brief carries", () => {
    expect(TASK_BRIEF_PROMPT_VERSION).toBe("v2");
  });

  it("asks for the stage segments the summary parser refuses anything else than", () => {
    expect(SUMMARY_INSTRUCTION).toContain("segments:[{range,summary,key_points,evidence}]");
    // The shape the instruction asks for is the shape the parser accepts.
    expect(() =>
      parseSummaryPayload(
        '{"title":"t","overview":"o","segments":[{"range":"1-6","summary":"s","key_points":[],"evidence":[1,6]}],"decisions":[],"issues":[]}',
      ),
    ).not.toThrow();
    expect(() => parseSummaryPayload('{"overview":"o"}')).toThrow(
      "The summary model did not return the expected JSON shape.",
    );
  });

  it("asks for a brief paragraph and the facts the brief reader reads back", () => {
    expect(TASK_BRIEF_INSTRUCTION).toContain('{"brief":"概述文字","facts":');
    expect(TASK_BRIEF_INSTRUCTION).toContain("agent");
    expect(TASK_BRIEF_INSTRUCTION).toContain("cwd");
    expect(TASK_BRIEF_INSTRUCTION).toContain("git_branch");
    expect(TASK_BRIEF_INSTRUCTION).toContain("os");
    const accepted = parseTaskBriefContent(
      '{"brief":"一段概述。","facts":{"agent":"pi","cwd":"d:/code","git_branch":"main","os":"Windows"}}',
    );
    expect(accepted.text).toBe("一段概述。");
    expect(Object.keys(accepted.facts).sort()).toEqual(["agent", "cwd", "git_branch", "os"]);
  });

  it("keeps the brief budget the card was built around", () => {
    expect(TASK_BRIEF_FACT_LIMIT).toBe(6);
    expect(TASK_BRIEF_FACT_VALUE_LIMIT).toBe(200);
  });

  it("does not rewrite an instruction that a stored answer was made under", () => {
    // The two instructions are separate: a summary is asked for stages, a brief for a
    // paragraph. Neither contains the other's contract.
    expect(SUMMARY_INSTRUCTION).not.toContain("brief");
    expect(TASK_BRIEF_INSTRUCTION).not.toContain("segments:[");
  });
});
