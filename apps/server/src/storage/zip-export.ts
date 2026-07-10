import type { Readable } from "node:stream";

import {
  RecordDetailSchema,
  RecordListResponseSchema,
  TaskListResponseSchema,
  type RecordDetail,
  type TaskSummary,
} from "@llm-proxy/contracts";
import { type Archiver, ZipArchive } from "archiver";

export interface ExportSource {
  listTasks(query: string, limit: number, offset: number): Promise<unknown>;
  listRecords(taskId: string, limit: number, offset: number): Promise<unknown>;
  getRecord(recordId: string): Promise<unknown>;
}

export interface ZipExportOptions {
  query?: string;
  signal?: AbortSignal;
}

export class ExportCapacityError extends Error {
  public readonly code = "EXPORT_CAPACITY_EXCEEDED";
}

export class StreamingZipExporter {
  readonly #maxConcurrent: number;
  #active = 0;

  public constructor(maxConcurrent = 2) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
      throw new RangeError("Invalid export concurrency");
    this.#maxConcurrent = maxConcurrent;
  }

  public export(source: ExportSource, options: ZipExportOptions = {}): Readable {
    if (this.#active >= this.#maxConcurrent) throw new ExportCapacityError("Too many concurrent exports");
    if (options.signal?.aborted) throw abortError();
    this.#active += 1;
    const archive = new ZipArchive({ zlib: { level: 6 } });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#active -= 1;
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      archive.destroy(abortError());
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    archive.once("end", release);
    archive.once("close", release);
    archive.once("error", release);
    setImmediate(() => {
      void produceArchive(archive, source, options.query ?? "", options.signal).catch((error: unknown) => {
        archive.destroy(error instanceof Error ? error : new Error("ZIP export failed"));
      });
    });
    return archive;
  }

  public get active(): number {
    return this.#active;
  }
}

async function produceArchive(
  archive: Archiver,
  source: ExportSource,
  query: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await appendEntry(archive, "manifest.json", { format: "llm-proxy-traffic", version: 1 }, signal);
  let taskOffset = 0;
  let hasMore = true;
  while (hasMore) {
    throwIfAborted(signal);
    const page = TaskListResponseSchema.parse(await source.listTasks(query, 50, taskOffset));
    for (const task of page.tasks) await appendTask(archive, source, task, signal);
    taskOffset += page.tasks.length;
    hasMore = page.hasMore;
    if (hasMore && page.tasks.length === 0) throw new Error("Task export pagination made no progress");
  }
  await archive.finalize();
}

async function appendTask(
  archive: Archiver,
  source: ExportSource,
  task: TaskSummary,
  signal: AbortSignal | undefined,
): Promise<void> {
  const directory = `tasks/${safeSegment(task.id)}`;
  await appendEntry(archive, `${directory}/task.json`, task, signal);
  let recordOffset = 0;
  let hasMore = true;
  while (hasMore) {
    throwIfAborted(signal);
    const page = RecordListResponseSchema.parse(await source.listRecords(task.id, 50, recordOffset));
    for (const summary of page.records) {
      throwIfAborted(signal);
      const detail = RecordDetailSchema.parse(await source.getRecord(summary.id));
      const sequence = detail.sequence.toString().padStart(8, "0");
      await appendEntry(archive, `${directory}/records/${sequence}-${safeSegment(detail.id)}.json`, detail, signal);
    }
    recordOffset += page.records.length;
    hasMore = page.hasMore;
    if (hasMore && page.records.length === 0) throw new Error("Record export pagination made no progress");
  }
}

async function appendEntry(
  archive: Archiver,
  name: string,
  value: RecordDetail | TaskSummary | Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const consumed = new Promise<void>((resolvePromise, rejectPromise) => {
    const onEntry = (): void => {
      archive.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      archive.off("entry", onEntry);
      rejectPromise(error);
    };
    archive.once("entry", onEntry);
    archive.once("error", onError);
  });
  archive.append(`${JSON.stringify(value)}\n`, { name });
  await consumed;
}

function safeSegment(value: string): string {
  const safe = value
    .replaceAll(/[^A-Za-z0-9._-]/gu, "_")
    .replaceAll("..", "_")
    .slice(0, 128);
  return safe.length > 0 && safe !== "." ? safe : "unknown";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("ZIP export aborted");
  error.name = "AbortError";
  return error;
}
