import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import type { SummaryModelConfig } from "../../src/config/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";
import { SummaryGenerationService } from "../../src/maintenance/summary-generation-service.js";
import type { SummaryModelGenerator } from "../../src/maintenance/summary-model-client.js";
import {
  SUMMARY_PROMPT_VERSION,
  TASK_BRIEF_PROMPT_VERSION,
} from "../../src/maintenance/summary-prompts.js";

/**
 * [AI-11] The summary and brief generation service: its cache, its concurrency guard
 * and its storage write.
 *
 * The model is a fake in this file, so nothing here reaches a paid upstream. What is
 * proven is the service's own behaviour: one record is generated once even when two
 * callers ask at the same time, the answer is remembered under the key the console reads
 * it back by, a refused second caller then sees exactly the stored text, the prompt
 * version stored beside an answer is the one the prompt module names, and a write that
 * cannot happen is reported instead of pretended.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const summaryConfig: SummaryModelConfig = {
  api_key: "summary-secret",
  api_type: "openai_chat",
  disable_reasoning: true,
  model: "summary-model",
  target_headers: [],
  target_url: "https://summary.example.com/v1",
  timeout_ms: 30_000,
};

const summaryPayload = {
  title: "Build stages",
  overview: "Two stages.",
  segments: [{ range: "1-2", summary: "install and build", key_points: [], evidence: [1, 2] }],
  decisions: [],
  issues: [],
  // A key this project never asked for, which has to survive the round trip.
  model_note: "written by the model",
};

const briefAnswer = '{"brief":"生成中。","facts":{}}';

/** A model that records how often it was asked and can be held on its answer. */
class FakeGenerator implements SummaryModelGenerator {
  readonly calls: { instruction: string; input: string }[] = [];
  #answer = JSON.stringify(summaryPayload);
  #waiting: Promise<void> | undefined;
  #waiter: (() => void) | undefined;
  #held = 0;

  /** Answer with this text from now on. */
  answering(text: string): void {
    this.#answer = text;
  }

  /** Make exactly the next call wait until `release()` is called. */
  holdNext(): void {
    this.#held = 1;
    this.#waiting = new Promise<void>((resolve) => {
      this.#waiter = resolve;
    });
  }

  release(): void {
    this.#waiter?.();
  }

  async generate(
    config: SummaryModelConfig,
    prompt: { instruction: string; input: string },
  ): Promise<string> {
    void config;
    this.calls.push({ instruction: prompt.instruction, input: prompt.input });
    if (this.#held > 0) {
      this.#held -= 1;
      await this.#waiting;
    }
    return this.#answer;
  }
}

/** The logger every service is given when no warnings are being asserted. */
const quietLogger = {
  warn(): void {
    // Diagnostics are not what these tests are about, so nothing is collected.
  },
};

function collectWarnings(): {
  warnings: { message: string; context: Readonly<Record<string, unknown>> }[];
  logger: { warn(message: string, context?: Readonly<Record<string, unknown>>): void };
} {
  const warnings: { message: string; context: Readonly<Record<string, unknown>> }[] = [];
  return {
    warnings,
    logger: {
      warn(message, context = {}) {
        warnings.push({ message, context });
      },
    },
  };
}

function task(id: string, model = "gpt-5", timestamp = "2026-07-18T10:00:00.000+08:00") {
  return {
    id,
    kind: "responses",
    model,
    target: "fixture-target",
    started_at: timestamp,
    last_seen_at: timestamp,
    last_response_at: timestamp,
    request_count: 2,
    pending_request_only: false,
  };
}

/** Seed one task with one finished request. */
function seedTaskRecord(
  root: string,
  taskId: string,
  recordId: string,
  sequence = 1,
  content = "seeded turn",
): void {
  const repository = new TrafficRepository(root);
  repository.upsertTask(task(taskId));
  repository.upsertRecord({
    id: recordId,
    task_id: taskId,
    sequence,
    event: "request_finished",
    method: "POST",
    path: "/v1/responses",
    request_body: { model: "gpt-5", input: [{ type: "message", content }] },
  });
  repository.close();
}

async function newRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `llm-proxy-${name}-`));
  temporaryDirectories.push(root);
  return root;
}

function generationService(
  roots: () => readonly string[],
  generator: SummaryModelGenerator,
  logger: {
    warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  } = quietLogger,
): SummaryGenerationService {
  return new SummaryGenerationService({ logRoots: roots, logger, generator });
}

/** The prompt version stored beside a generated text. */
function storedPromptVersion(
  root: string,
  table: "history_summaries" | "task_briefs",
  keyColumn: "record_id" | "task_id",
  key: string,
): string | undefined {
  const db = new Database(path.join(root, "traffic.db"));
  try {
    const row = db
      .prepare(`SELECT prompt_version FROM ${table} WHERE ${keyColumn} = ?`)
      .get(key) as { prompt_version?: string } | undefined;
    return row?.prompt_version;
  } finally {
    db.close();
  }
}

describe("SummaryGenerationService", () => {
  it("generates a summary, caches it under the record id, and reads it back unchanged", async () => {
    const root = await newRoot("summary-cache");
    seedTaskRecord(root, "summary-task", "summary-record");
    const generator = new FakeGenerator();
    const service = generationService(() => [root], generator);

    expect(service.cachedSummary("summary-record")).toBeUndefined();

    const summary = await service.summarizeRecord("summary-record", summaryConfig);
    expect(summary).toEqual(summaryPayload);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0]?.instruction).toContain("segments");
    // What the model is sent is the prepared request text, not a console view of it.
    expect(generator.calls[0]?.input).toContain("seeded turn");

    expect(service.cachedSummary("summary-record")).toEqual(summaryPayload);
    expect(storedPromptVersion(root, "history_summaries", "record_id", "summary-record")).toBe(
      SUMMARY_PROMPT_VERSION,
    );
    expect(SUMMARY_PROMPT_VERSION).toBe("v1");
  });

  it("overwrites the cached summary when a summary is asked for again", async () => {
    const firstRoot = await newRoot("summary-overwrite-a");
    const secondRoot = await newRoot("summary-overwrite-b");
    seedTaskRecord(firstRoot, "summary-task", "summary-record");
    const service = generationService(() => [firstRoot, secondRoot], new FakeGenerator());
    await service.summarizeRecord("summary-record", summaryConfig);

    const changed = { ...summaryPayload, title: "Second answer" };
    const secondGenerator = new FakeGenerator();
    secondGenerator.answering(JSON.stringify(changed));
    const secondService = generationService(() => [firstRoot, secondRoot], secondGenerator);
    await secondService.summarizeRecord("summary-record", summaryConfig);

    expect(secondService.cachedSummary("summary-record")).toEqual(changed);
    expect(storedPromptVersion(firstRoot, "history_summaries", "record_id", "summary-record")).toBe(
      SUMMARY_PROMPT_VERSION,
    );
  });

  it("answers undefined for a record no log root holds and calls no model", async () => {
    const root = await newRoot("summary-absent");
    const generator = new FakeGenerator();
    const service = generationService(() => [root], generator);

    await expect(service.summarizeRecord("missing-record", summaryConfig)).resolves.toBeUndefined();
    expect(generator.calls).toHaveLength(0);
    expect(service.cachedSummary("missing-record")).toBeUndefined();
  });

  it("refuses a second generation of the same record and calls the model only once", async () => {
    const root = await newRoot("summary-conflict");
    seedTaskRecord(root, "summary-task", "summary-record");
    const generator = new FakeGenerator();
    generator.holdNext();
    const service = generationService(() => [root], generator);

    const started = service.summarizeRecord("summary-record", summaryConfig);

    await expect(service.summarizeRecord("summary-record", summaryConfig)).rejects.toMatchObject({
      name: "ApplicationError",
      code: "conflict",
      statusCode: 409,
      expose: true,
      message: "A summary is already being generated for this record.",
    });
    // Two callers, one upstream call.
    expect(generator.calls).toHaveLength(1);

    generator.release();
    expect(await started).toEqual(summaryPayload);

    // What the refused caller sees afterwards is the stored summary, read back exactly.
    expect(service.cachedSummary("summary-record")).toEqual(summaryPayload);
    const db = new Database(path.join(root, "traffic.db"));
    try {
      const stored = db
        .prepare("SELECT summary_json FROM history_summaries WHERE record_id = 'summary-record'")
        .get() as { summary_json: string } | undefined;
      if (stored === undefined) throw new Error("The summary was not stored.");
      expect(JSON.parse(stored.summary_json)).toEqual(summaryPayload);
    } finally {
      db.close();
    }

    // The guard is gone once the generation has finished.
    await expect(service.summarizeRecord("summary-record", summaryConfig)).resolves.toEqual(
      summaryPayload,
    );
  });

  it("lets a different record generate while one record is busy", async () => {
    const root = await newRoot("summary-other-record");
    seedTaskRecord(root, "summary-task", "summary-record");
    seedTaskRecord(root, "summary-task", "other-record", 2, "another turn");
    const generator = new FakeGenerator();
    generator.holdNext();
    const service = generationService(() => [root], generator);

    const started = service.summarizeRecord("summary-record", summaryConfig);
    // Another record is another job, so it is not refused and does not wait.
    await expect(service.summarizeRecord("other-record", summaryConfig)).resolves.toEqual(
      summaryPayload,
    );
    generator.release();
    await started;
    expect(generator.calls).toHaveLength(2);
  });

  it("stores a summary only in the root that owns the record", async () => {
    const firstRoot = await newRoot("summary-roots-a");
    const secondRoot = await newRoot("summary-roots-b");
    seedTaskRecord(secondRoot, "summary-task", "summary-record");
    const service = generationService(() => [firstRoot, secondRoot], new FakeGenerator());

    expect(await service.summarizeRecord("summary-record", summaryConfig)).toEqual(summaryPayload);
    expect(service.cachedSummary("summary-record")).toEqual(summaryPayload);
    const empty = new Database(path.join(firstRoot, "traffic.db"));
    try {
      expect(
        (empty.prepare("SELECT COUNT(*) AS n FROM history_summaries").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      empty.close();
    }
  });

  it("reports a summary that could not be stored instead of pretending it was saved", async () => {
    const root = await newRoot("summary-save-failure");
    seedTaskRecord(root, "summary-task", "summary-record");
    const { warnings, logger } = collectWarnings();
    const service = generationService(() => [root], new FakeGenerator(), logger);
    const breaker = new Database(path.join(root, "traffic.db"));
    breaker.exec("DROP TABLE history_summaries");
    breaker.close();

    await expect(service.summarizeRecord("summary-record", summaryConfig)).rejects.toMatchObject({
      name: "ApplicationError",
      code: "storage_error",
      statusCode: 500,
      message: "The summary could not be saved.",
      details: { phase: "history_summary_save", record_id: "summary-record" },
    });
    expect(warnings).toEqual([
      {
        message: "Summary save failed",
        context: {
          phase: "history_summary_save",
          record_id: "summary-record",
          log_root: root,
          error_type: "SqliteError",
          cause_type: "UnknownError",
        },
      },
    ]);
  });

  it("names the root when a cached summary cannot be read", async () => {
    const root = await newRoot("summary-read-failure");
    seedTaskRecord(root, "summary-task", "summary-record");
    const { warnings, logger } = collectWarnings();
    const service = generationService(() => [root], new FakeGenerator(), logger);
    const breaker = new Database(path.join(root, "traffic.db"));
    breaker.exec("DROP TABLE history_summaries");
    breaker.close();

    expect(service.cachedSummary("summary-record")).toBeUndefined();
    expect(warnings).toEqual([
      {
        message: "Summary read failed",
        context: {
          phase: "history_summary_read",
          record_id: "summary-record",
          log_root: root,
          error_type: "SqliteError",
          cause_type: "UnknownError",
        },
      },
    ]);
  });

  it("shows a stored summary that is not an object as absent", async () => {
    const root = await newRoot("summary-corrupt");
    seedTaskRecord(root, "summary-task", "summary-record");
    const db = new Database(path.join(root, "traffic.db"));
    try {
      db.prepare(
        "INSERT INTO history_summaries(record_id,status,summary_json,model,prompt_version,created_at,updated_at) VALUES('summary-record','ready','a plain sentence','m','v1','2026-07-18T10:00:00.000Z','2026-07-18T10:00:00.000Z')",
      ).run();
    } finally {
      db.close();
    }
    expect(
      generationService(() => [root], new FakeGenerator()).cachedSummary("summary-record"),
    ).toBe(undefined);
  });

  it("generates a brief from the newest request and caches it under the task id", async () => {
    const root = await newRoot("brief-cache");
    const repository = new TrafficRepository(root);
    repository.upsertTask(task("brief-task"));
    repository.upsertRecord({
      id: "brief-record-old",
      task_id: "brief-task",
      sequence: 1,
      event: "request_finished",
      request_body: { model: "gpt-5", input: [{ type: "message", content: "older turn" }] },
    });
    repository.upsertRecord({
      id: "brief-record-new",
      task_id: "brief-task",
      sequence: 2,
      event: "request_finished",
      request_headers: {
        "user-agent": "pi (win32 10.0.26100; x64)",
        "content-type": "text/plain",
      },
      request_body: { model: "gpt-5", input: [{ type: "message", content: "newest turn" }] },
    });
    repository.close();

    const generator = new FakeGenerator();
    generator.answering(
      JSON.stringify({ brief: "在调试流式转发。", facts: { agent: "pi 0.39", cwd: "d:/code" } }),
    );
    const service = generationService(() => [root], generator);
    expect(service.cachedBrief("brief-task")).toBeUndefined();

    const brief = await service.generateTaskBrief("brief-task", summaryConfig);
    expect(brief).toMatchObject({
      task_id: "brief-task",
      text: "在调试流式转发。",
      model: "summary-model",
      source_record_id: "brief-record-new",
      context: { agent: "pi 0.39", cwd: "d:/code" },
    });
    expect(generator.calls).toHaveLength(1);
    // The newest complete request is what the model sees, with the client hints beside it.
    expect(generator.calls[0]?.input).toContain("newest turn");
    expect(generator.calls[0]?.input).not.toContain("older turn");
    expect(generator.calls[0]?.input).toContain("pi (win32 10.0.26100; x64)");
    expect(generator.calls[0]?.input).not.toContain("text/plain");
    expect(service.cachedBrief("brief-task")?.text).toBe("在调试流式转发。");
    expect(storedPromptVersion(root, "task_briefs", "task_id", "brief-task")).toBe(
      TASK_BRIEF_PROMPT_VERSION,
    );
    expect(TASK_BRIEF_PROMPT_VERSION).toBe("v2");
  });

  it("refuses a second brief for the same task and calls the model only once", async () => {
    const root = await newRoot("brief-conflict");
    seedTaskRecord(root, "brief-task", "brief-record");
    const generator = new FakeGenerator();
    generator.answering(briefAnswer);
    generator.holdNext();
    const service = generationService(() => [root], generator);

    const started = service.generateTaskBrief("brief-task", summaryConfig);
    await expect(service.generateTaskBrief("brief-task", summaryConfig)).rejects.toMatchObject({
      code: "conflict",
      statusCode: 409,
      message: "A task brief is already being generated for this task.",
    });
    expect(generator.calls).toHaveLength(1);
    generator.release();
    expect(await started).toMatchObject({ task_id: "brief-task", text: "生成中。" });
    // The refused caller reads the same stored brief, under the task id.
    expect(service.cachedBrief("brief-task")).toMatchObject({
      task_id: "brief-task",
      text: "生成中。",
      source_record_id: "brief-record",
    });
  });

  it("answers a task that exists in no root as not found", async () => {
    const root = await newRoot("brief-absent");
    const generator = new FakeGenerator();
    const service = generationService(() => [root], generator);

    await expect(service.generateTaskBrief("missing-task", summaryConfig)).rejects.toMatchObject({
      name: "ApplicationError",
      code: "not_found",
      statusCode: 404,
      expose: true,
      message: "Log group not found.",
    });
    expect(generator.calls).toHaveLength(0);
  });

  it("reports an empty brief answer as a model failure", async () => {
    const root = await newRoot("brief-empty");
    seedTaskRecord(root, "brief-task", "brief-record");
    const generator = new FakeGenerator();
    generator.answering('{"brief":"","facts":{}}');
    const service = generationService(() => [root], generator);

    await expect(service.generateTaskBrief("brief-task", summaryConfig)).rejects.toMatchObject({
      code: "upstream_error",
      statusCode: 502,
      message: "The summary model returned an empty task brief.",
    });
    expect(service.cachedBrief("brief-task")).toBeUndefined();
  });

  it("reports a brief that could not be stored and names the phase", async () => {
    const root = await newRoot("brief-save");
    seedTaskRecord(root, "brief-task", "brief-record");
    const { warnings, logger } = collectWarnings();
    const generator = new FakeGenerator();
    generator.answering('{"brief":"已完成。","facts":{}}');
    const service = generationService(() => [root], generator, logger);
    const breaker = new Database(path.join(root, "traffic.db"));
    breaker.exec("DROP TABLE task_briefs");
    breaker.close();

    await expect(service.generateTaskBrief("brief-task", summaryConfig)).rejects.toMatchObject({
      code: "storage_error",
      statusCode: 500,
      message: "The task brief could not be saved.",
      details: { phase: "task_brief_save", task_id: "brief-task" },
    });
    expect(warnings).toEqual([
      {
        message: "Task brief save failed",
        context: {
          phase: "task_brief_save",
          task_id: "brief-task",
          log_root: root,
          error_type: "SqliteError",
          cause_type: "UnknownError",
        },
      },
    ]);
  });

  it("stores the brief only in the root that owns the task", async () => {
    const firstRoot = await newRoot("brief-roots-a");
    const secondRoot = await newRoot("brief-roots-b");
    seedTaskRecord(secondRoot, "cross-task", "cross-record");
    const generator = new FakeGenerator();
    generator.answering("跨目录的任务简介。");
    const service = generationService(() => [firstRoot, secondRoot], generator);

    expect((await service.generateTaskBrief("cross-task", summaryConfig)).text).toBe(
      "跨目录的任务简介。",
    );
    expect(service.cachedBrief("cross-task")?.text).toBe("跨目录的任务简介。");
    const empty = new Database(path.join(firstRoot, "traffic.db"));
    try {
      expect(
        (empty.prepare("SELECT COUNT(*) AS n FROM task_briefs").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      empty.close();
    }
  });

  it("resolves the log roots when a generation runs, not once at creation", async () => {
    const firstRoot = await newRoot("latest-a");
    const secondRoot = await newRoot("latest-b");
    const roots: string[] = [firstRoot];
    const generator = new FakeGenerator();
    generator.answering("简介来自新目录。");
    const service = generationService(() => roots, generator);

    await expect(service.generateTaskBrief("late-task", summaryConfig)).rejects.toMatchObject({
      code: "not_found",
    });
    seedTaskRecord(secondRoot, "late-task", "late-record");
    roots.push(secondRoot);

    expect((await service.generateTaskBrief("late-task", summaryConfig)).source_record_id).toBe(
      "late-record",
    );
    expect(service.cachedBrief("late-task")?.text).toBe("简介来自新目录。");
  });

  it("reads a stored brief back with its facts, dropping what is not a short string", async () => {
    const root = await newRoot("brief-read");
    seedTaskRecord(root, "brief-task", "brief-record");
    const db = new Database(path.join(root, "traffic.db"));
    try {
      db.prepare(
        "INSERT INTO task_briefs(task_id,status,brief_text,source_record_id,model,prompt_version,context_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        "brief-task",
        "ready",
        "一段简介",
        "brief-record",
        "m",
        "v2",
        '{"cwd":"/repo","nested":1,"": "blank key"}',
        "2026-07-18T10:00:00.000Z",
        "2026-07-18T11:00:00.000Z",
      );
    } finally {
      db.close();
    }
    expect(generationService(() => [root], new FakeGenerator()).cachedBrief("brief-task")).toEqual({
      task_id: "brief-task",
      text: "一段简介",
      context: { cwd: "/repo" },
      model: "m",
      generated_at: "2026-07-18T11:00:00.000Z",
      source_record_id: "brief-record",
    });
  });

  it("shows a stored brief with an empty paragraph as absent", async () => {
    const root = await newRoot("brief-empty-row");
    seedTaskRecord(root, "brief-task", "brief-record");
    const db = new Database(path.join(root, "traffic.db"));
    try {
      db.prepare(
        "INSERT INTO task_briefs(task_id,status,brief_text,source_record_id,model,prompt_version,context_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        "brief-task",
        "ready",
        "",
        "brief-record",
        "m",
        "v2",
        null,
        "2026-07-18T10:00:00.000Z",
        "2026-07-18T11:00:00.000Z",
      );
    } finally {
      db.close();
    }
    expect(generationService(() => [root], new FakeGenerator()).cachedBrief("brief-task")).toBe(
      undefined,
    );
  });
});
