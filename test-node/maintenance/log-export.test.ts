import { describe, expect, it } from "vitest";

import { recordExportDirectory, taskExportDirectory } from "../../src/maintenance/index.js";

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
