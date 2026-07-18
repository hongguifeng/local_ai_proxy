import { describe, expect, it } from "vitest";

import {
  recordExportDirectory,
  recordJsonEntries,
  renderRecordSummaryMarkdown,
  renderTaskIndexMarkdown,
  taskExportDirectory,
} from "../../src/maintenance/index.js";

describe("log export directory names", () => {
  it("creates bounded safe task directory names", () => {
    const name = taskExportDirectory({
      id: "task/id-with-a-very-long-suffix",
      kind: "responses api",
      model: "vendor/model:测试",
      started_at: "2026-07-18T12:34:56+08:00",
    });

    expect(name).toMatch(
      /^2026-07-18__12-34-56__vendor-model-测试__responses-api__task-id-with-a-v$/,
    );
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("creates sortable safe record directory names with fallbacks", () => {
    expect(recordExportDirectory({ id: "record/id", sequence: 7, endpoint: "/v1/responses" })).toBe(
      "007__v1-responses__record-id",
    );
    expect(recordExportDirectory({})).toBe("000__request__record");
    expect(taskExportDirectory({ started_at: "invalid/date" })).toBe(
      "invalid-date__unknown-model__task__task",
    );
  });
});

describe("task export Markdown", () => {
  it("renders summary fields and an ascending linked timeline", () => {
    const markdown = renderTaskIndexMarkdown(
      {
        id: "task-1",
        kind: "responses",
        model: "gpt-5",
        target: "fixture-target",
        started_at: "2026-07-18T12:00:00+08:00",
        last_seen_at: "2026-07-18T12:00:02+08:00",
        last_response_at: "2026-07-18T12:00:03+08:00",
        request_count: 2,
      },
      [
        {
          id: "record-2",
          sequence: 2,
          method: "POST",
          path: "/v1/responses",
          duration_ms: 12,
          status: 200,
          endpoint: "/v1/responses",
        },
        {
          id: "record-1",
          sequence: 1,
          method: "POST",
          path: "/v1/responses",
          duration_ms: 0,
          status: null,
          endpoint: "/v1/responses",
        },
      ],
    );

    expect(markdown).toContain("# LLM Task task-1");
    expect(markdown).toContain("- Model: gpt-5");
    expect(markdown).toContain("- Target: fixture-target");
    expect(markdown.indexOf("001 `POST /v1/responses` -> pending")).toBeLessThan(
      markdown.indexOf("002 `POST /v1/responses` -> 200"),
    );
    expect(markdown).toContain("[record-2](002__v1-responses__record-2/)");
  });
});

describe("record export Markdown", () => {
  it("renders interaction metadata, errors, and body entry links", () => {
    const markdown = renderRecordSummaryMarkdown(
      { id: "task-1", kind: "responses" },
      {
        id: "record-1",
        sequence: 3,
        timestamp: "2026-07-18T12:34:56+08:00",
        event: "request_finished",
        duration_ms: 42,
        target_url: "http://fixture/v1/responses",
        method: "POST",
        path: "/v1/responses",
        endpoint: "/v1/responses",
        message_count: 2,
        token_count: 9,
        status: 502,
        error: "upstream failed",
      },
    );

    expect(markdown).toContain("# LLM Interaction record-1");
    expect(markdown).toContain("- Time: 2026-07-18 12:34:56");
    expect(markdown).toContain("- Error: upstream failed");
    expect(markdown).toContain("- Task: responses / task-1 / request 3");
    expect(markdown).toContain("See `request.json`.");
    expect(markdown).toContain("See `response.json`.");
  });
});

describe("record JSON export entries", () => {
  it("writes pretty UTF-8-safe request and response JSON including null", () => {
    expect(recordJsonEntries({ request_body: { input: "你好" }, response_body: null })).toEqual([
      { name: "request.json", text: '{\n  "input": "你好"\n}' },
      { name: "response.json", text: "null" },
    ]);
  });
});
