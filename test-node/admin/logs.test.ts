import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { ApplicationError, conflict, notFound, storageError } from "../../src/shared/index.js";
import type { LogGroupPage } from "../../src/maintenance/index.js";
import {
  cleanupResult,
  emptyGroupPage,
  exportStream,
  historySummary,
  listRecord,
  recordBatch,
  recordDetail,
  taskBrief,
} from "./log-service-fixtures.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /api/logs", () => {
  it("cleans selected log groups", async () => {
    const logService = {
      calls: [] as unknown[],
      listGroups: () => emptyGroupPage(),
      cleanupSelectedGroups(groupIds: readonly string[]) {
        this.calls.push(groupIds);
        return cleanupResult(groupIds);
      },
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService,
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/cleanup",
      payload: { group_ids: ["task-1"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: ["task-1"], deleted_count: 1 });
    expect(logService.calls).toEqual([["task-1"]]);
  });

  it("cleans log groups older than a requested number of days", async () => {
    const calls: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        cleanupOlderThan(days) {
          calls.push(days);
          return cleanupResult(["old"]);
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/cleanup",
      payload: { older_than_days: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: ["old"], deleted_count: 1 });
    expect(calls).toEqual([7]);
  });

  it("cleans all but the latest requested log groups", async () => {
    const calls: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        cleanupKeepLatest(count) {
          calls.push(count);
          return cleanupResult(["old"]);
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/cleanup",
      payload: { keep_latest: 10 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: ["old"], deleted_count: 1 });
    expect(calls).toEqual([10]);
  });

  it("streams the ZIP export with download headers", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        exportLogs: () => exportStream("zip-stream"),
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/logs/export" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="llm-proxy-logs.zip"',
    );
    expect(response.rawPayload.toString()).toBe("zip-stream");
  });

  it("passes search and pagination query values to the log service", async () => {
    const calls: unknown[] = [];
    const page: LogGroupPage = {
      groups: [],
      total: 2,
      limit: 1,
      offset: 1,
      next_offset: 2,
      has_more: false,
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups(query, limit, offset) {
          calls.push({ query, limit, offset });
          return page;
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/logs?q=gpt-5&limit=1&offset=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(calls).toEqual([{ query: "gpt-5", limit: 1, offset: 1 }]);
  });

  it("returns task group logs and a JSON 404 for missing groups", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        getGroupLogs(groupId, query) {
          return groupId === "known"
            ? {
                id: groupId,
                total: 1,
                limit: 200,
                offset: 0,
                next_offset: 1,
                has_more: false,
                logs: [
                  {
                    id: "record",
                    timestamp: "",
                    sequence: "1",
                    method: "POST",
                    path: "/",
                    endpoint: query,
                    message_count: null,
                    status: 200,
                    request_token_count: null,
                    response_token_count: null,
                    target: "",
                    has_summary: false,
                  },
                ],
              }
            : undefined;
        },
      },
    });
    servers.push(server);

    const known = await server.inject({
      method: "GET",
      url: "/api/log-groups/known/logs?q=needle",
    });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toMatchObject({ id: "known", logs: [{ endpoint: "needle" }] });
    const missing = await server.inject({ method: "GET", url: "/api/log-groups/missing/logs" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "log_group_not_found", message: "Log group not found." },
    });
  });

  it("returns record detail and a JSON 404 for missing records", async () => {
    const detail = recordDetail("known-record");
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        getRecordDetail: (recordId) => (recordId === detail.id ? detail : undefined),
      },
    });
    servers.push(server);

    const known = await server.inject({ method: "GET", url: "/api/logs/known-record" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual(detail);
    const missing = await server.inject({ method: "GET", url: "/api/logs/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "log_record_not_found", message: "Log record not found." },
    });
  });

  it("reads many records in one body-free batch request", async () => {
    const calls: (readonly string[])[] = [];
    const inFlight = listRecord("in-flight", true);
    const done = listRecord("done", false);
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        listRecordsByIds: (ids) => {
          calls.push(ids);
          return recordBatch([inFlight, done].filter((record) => ids.includes(record.id)));
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/logs/records?ids=in-flight,done,in-flight",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(recordBatch([inFlight, done]));
    // Repeated ids are collapsed and surrounding whitespace is trimmed.
    expect(calls).toEqual([["in-flight", "done"]]);

    const noIds = await server.inject({ method: "GET", url: "/api/logs/records?ids=%20" });
    expect(noIds.statusCode).toBe(400);
    expect(noIds.json()).toEqual({
      error: { code: "invalid_request", message: "At least one record id is required." },
    });

    const missingParam = await server.inject({ method: "GET", url: "/api/logs/records" });
    expect(missingParam.statusCode).toBe(400);
    expect(missingParam.json()).toMatchObject({
      error: { code: "FST_ERR_VALIDATION" },
    });
  });

  it("omits the batch route when the log service cannot read by ids", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/logs/records?ids=any" });
    expect(response.statusCode).toBe(404);
  });
});

describe("generation error classification", () => {
  // [AI-05] The status and the admin code come from the error's classification, never from
  // its message text, so rewording an error cannot move a request to a different status.
  function generationServer(
    failure: () => Promise<never>,
    warnings?: { message: string; context: Readonly<Record<string, unknown>> }[],
  ): ReturnType<typeof createAdminServer> {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      ...(warnings === undefined
        ? {}
        : {
            logger: {
              info: () => undefined,
              warn(message, context = {}) {
                warnings.push({ message, context });
              },
            },
          }),
      logService: {
        listGroups: () => emptyGroupPage(),
        generateTaskBrief: () => failure(),
        summarizeRecord: () => failure(),
      },
    });
    servers.push(server);
    return server;
  }

  it("[AI-05] answers an in-progress brief with 409 regardless of the wording", async () => {
    const first = await generationServer(() =>
      Promise.reject(conflict("A task brief is already being generated for this task.")),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });
    const second = await generationServer(() =>
      Promise.reject(conflict("Reworded in-progress state.")),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });

    expect(first.statusCode).toBe(409);
    expect(first.json()).toEqual({
      error: {
        code: "task_brief_in_progress",
        message: "A task brief is already being generated for this task.",
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: { code: "task_brief_in_progress", message: "Reworded in-progress state." },
    });
  });

  it("[AI-05] answers an unknown group with 404", async () => {
    const response = await generationServer(() =>
      Promise.reject(notFound("Log group not found.")),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "log_group_not_found", message: "Log group not found." },
    });
  });

  it("[AI-05] shows the model status but never the credential behind it", async () => {
    const response = await generationServer(() =>
      Promise.reject(
        new ApplicationError("The summary model returned HTTP 401.", {
          cause: new Error("upstream rejected key sk-live-secret"),
          code: "upstream_error",
          expose: true,
          statusCode: 502,
        }),
      ),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: "task_brief_failed", message: "The summary model returned HTTP 401." },
    });
    expect(response.body).not.toContain("sk-live-secret");
  });

  it("[AI-05] answers a storage failure with 500 and a generic message", async () => {
    const response = await generationServer(() =>
      Promise.reject(
        storageError("The task brief could not be saved.", {
          cause: new Error("SQLITE_BUSY while writing C:\\private\\traffic.db"),
          details: { phase: "task_brief_save", task_id: "task-1" },
        }),
      ),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "storage_failed", message: "The result could not be saved." },
    });
    expect(response.body).not.toContain("traffic.db");
    expect(response.body).not.toContain("task-1");
  });

  it("[AI-05] keeps an unexpected internal error generic", async () => {
    const brief = await generationServer(() =>
      Promise.reject(new Error("decoding C:\\private\\traffic.db failed")),
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });
    const summary = await generationServer(() =>
      Promise.reject(new Error("decoding C:\\private\\traffic.db failed")),
    ).inject({ method: "POST", url: "/api/logs/record-1/summary" });

    expect(brief.statusCode).toBe(502);
    expect(brief.json()).toEqual({
      error: { code: "task_brief_failed", message: "The request failed." },
    });
    expect(summary.statusCode).toBe(502);
    expect(summary.json()).toEqual({
      error: { code: "summary_failed", message: "The request failed." },
    });
    expect(brief.body).not.toContain("traffic.db");
    expect(summary.body).not.toContain("traffic.db");
  });

  it("[AI-05] logs the reason when nothing was expected", async () => {
    const warnings: { message: string; context: Readonly<Record<string, unknown>> }[] = [];
    const server = generationServer(
      () =>
        Promise.reject(
          new TypeError("cannot read C:\\private\\traffic.db", { cause: new Error("EBUSY") }),
        ),
      warnings,
    );

    const brief = await server.inject({ method: "POST", url: "/api/log-groups/task-1/brief" });
    const summary = await server.inject({ method: "POST", url: "/api/logs/record-1/summary" });

    expect(brief.statusCode).toBe(502);
    expect(summary.statusCode).toBe(502);
    expect(warnings).toEqual([
      {
        message: "Task brief generation failed",
        context: {
          phase: "task_brief_generate",
          task_id: "task-1",
          error_type: "TypeError",
          cause_type: "Error",
        },
      },
      {
        message: "Record summary generation failed",
        context: {
          phase: "record_summary_generate",
          record_id: "record-1",
          error_type: "TypeError",
          cause_type: "Error",
        },
      },
    ]);
    // The error text can name a private path; only its type belongs in the log.
    expect(JSON.stringify(warnings)).not.toContain("private");
    expect(JSON.stringify(warnings)).not.toContain("EBUSY");
  });

  it("[AI-05] does not log again for an error that is already classified", async () => {
    const warnings: { message: string; context: Readonly<Record<string, unknown>> }[] = [];

    const response = await generationServer(
      () => Promise.reject(conflict("A task brief is already being generated for this task.")),
      warnings,
    ).inject({ method: "POST", url: "/api/log-groups/task-1/brief" });

    expect(response.statusCode).toBe(409);
    expect(warnings).toEqual([]);
  });

  it("[AI-05] answers an in-progress summary with 409", async () => {
    const response = await generationServer(() =>
      Promise.reject(conflict("A summary is already being generated for this record.")),
    ).inject({ method: "POST", url: "/api/logs/record-1/summary" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "summary_in_progress",
        message: "A summary is already being generated for this record.",
      },
    });
  });
});

describe("[AI-07] stored and absent generation results", () => {
  // "Nothing is stored" and "no such record" have to look different to the browser: an
  // absent brief or summary answers JSON null, an unknown record answers a coded 404.
  it("answers a stored summary verbatim and an absent one as null", async () => {
    const summary = historySummary();
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        getSummary: (recordId) => (recordId === "known-record" ? summary : undefined),
        summarizeRecord: () => Promise.resolve(undefined),
      },
    });
    servers.push(server);

    const stored = await server.inject({ method: "GET", url: "/api/logs/known-record/summary" });
    expect(stored.statusCode).toBe(200);
    // The summary model's own keys, including one this project never declared, survive.
    expect(stored.json()).toEqual(summary);

    const absent = await server.inject({ method: "GET", url: "/api/logs/other-record/summary" });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toBeNull();
  });

  it("answers a stored task brief and an absent one", async () => {
    const brief = taskBrief("task-1");
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        getTaskBrief: (groupId) => (groupId === "task-1" ? brief : undefined),
        generateTaskBrief: () => Promise.resolve(brief),
      },
    });
    servers.push(server);

    const stored = await server.inject({ method: "GET", url: "/api/log-groups/task-1/brief" });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual(brief);

    const absent = await server.inject({ method: "GET", url: "/api/log-groups/task-2/brief" });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toBeNull();
  });

  it("answers a summary for a record no root holds with record_not_found", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        summarizeRecord: () => Promise.resolve(undefined),
        getSummary: () => undefined,
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/missing-record/summary",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "record_not_found", message: "Record not found." },
    });
  });
});
