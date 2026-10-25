import { describe, expect, it } from "vitest";

import type { LogAdminService } from "../../src/admin/admin-contracts.js";
import type { HistorySummary, LogRecordDetail } from "../../src/maintenance/index.js";
import {
  emptyGroupPage,
  historySummary,
  listRecord,
  recordBatch,
  recordDetail,
  taskBrief,
} from "./log-service-fixtures.js";

/**
 * These checks exist so the compiler, not a reviewer, notices a renamed service field or a
 * payload that is not the declared model. An `@ts-expect-error` that stops being an error
 * fails the build, which is how this file keeps its value.
 */

/** The one method every log service has to answer, whatever else it wires. */
function requiredService(): LogAdminService {
  return { listGroups: () => emptyGroupPage() };
}

describe("[AI-07] admin log contract shape", () => {
  it("is satisfied by a service that answers the declared models", () => {
    const service: LogAdminService = {
      ...requiredService(),
      getSummary: () => undefined,
      summarizeRecord: () => Promise.resolve(undefined),
      getTaskBrief: () => undefined,
      generateTaskBrief: () => Promise.resolve(taskBrief()),
      listRecordsByIds: (ids) => recordBatch(ids.map((id) => listRecord(id, false))),
      getRecordDetail: (recordId) => recordDetail(recordId),
      getGroupPricing: () => undefined,
      getGroupTokenSeries: () => undefined,
      getGroupCostSeries: () => undefined,
      getGroupOutputTokenSeries: () => undefined,
    };

    expect(service.listGroups("", 10, 0)).toMatchObject({ groups: [], total: 0 });
    expect(service.listRecordsByIds?.(["record-1", "record-2"]).records).toHaveLength(2);
  });

  it("[AI-07] refuses a service that cannot list groups at all", () => {
    // @ts-expect-error listGroups is required: a service without it would answer nothing
    const missingRequiredMethod: LogAdminService = {};
    expect(missingRequiredMethod).toBeDefined();
  });

  it("[AI-07] refuses a summary that is the model's text instead of its JSON", () => {
    const service: LogAdminService = {
      ...requiredService(),
      // @ts-expect-error a stored summary is an object, never the raw text it came in as
      getSummary: () => '{"title":"x"}',
    };
    expect(service).toBeDefined();
  });

  it("[AI-07] refuses a brief whose paragraph is named something else", () => {
    const service: LogAdminService = {
      ...requiredService(),
      // @ts-expect-error the brief paragraph is `text`; `brief_text` is the storage column
      getTaskBrief: () => ({ task_id: "task-1", brief_text: "a paragraph" }),
    };
    expect(service).toBeDefined();
  });

  it("[AI-07] refuses a batch read that answers nothing", () => {
    const service: LogAdminService = {
      ...requiredService(),
      // @ts-expect-error the batch read always answers a record list, even an empty one
      listRecordsByIds: () => undefined,
    };
    expect(service).toBeDefined();
  });

  it("[AI-07] refuses a task cost written as a number", () => {
    const service: LogAdminService = {
      ...requiredService(),
      // @ts-expect-error cost_nano_cny stays text so a large amount keeps its precision
      getGroupPricing: () => ({ cost_nano_cny: 42_750_000 }),
    };
    expect(service).toBeDefined();
  });

  it("[AI-07] refuses a token series that is not a list", () => {
    const service: LogAdminService = {
      ...requiredService(),
      // @ts-expect-error the series is one point per request, in sequence order
      getGroupTokenSeries: () => ({ sequence: 1, request_tokens: 1 }),
    };
    expect(service).toBeDefined();
  });

  it("[AI-07] refuses a record detail with no pricing block", () => {
    // @ts-expect-error a detail always carries pricing; null is its "nothing priced" answer
    const detailWithoutPricing: LogRecordDetail = {
      id: "record-1",
      pending: false,
      request: { input: "hello" },
      response: { output: "world" },
      request_meta: { method: "POST" },
      response_meta: { status: 200 },
    };
    expect(detailWithoutPricing).toBeDefined();
  });

  it("[AI-07] keeps keys the summary model added readable", () => {
    const summary: HistorySummary = historySummary();
    // A declared field reads with a dot; a key the model invented needs brackets.
    expect(summary.title).toBe("Build stages");
    expect(summary["model_note"]).toBe("kept verbatim");

    const service: LogAdminService = {
      ...requiredService(),
      getSummary: () => summary,
    };
    expect(service.getSummary?.("record-1")).toEqual(summary);
  });

  it("[AI-07] answers an absent summary, brief and generation with undefined", async () => {
    const service: LogAdminService = {
      ...requiredService(),
      getSummary: () => undefined,
      getTaskBrief: () => undefined,
      summarizeRecord: () => Promise.resolve(undefined),
    };

    expect(service.getSummary?.("record-1")).toBeUndefined();
    expect(service.getTaskBrief?.("task-1")).toBeUndefined();
    await expect(service.summarizeRecord?.("record-1")).resolves.toBeUndefined();
  });
});
