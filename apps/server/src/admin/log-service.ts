import { RecordDetailSchema, RecordListResponseSchema } from "@llm-proxy/contracts";

import { MultiRootTaskQuery, type MultiRootTaskPage, type TaskQuerySource } from "../storage/multi-root-query.js";
import { StreamingZipExporter, type ExportSource } from "../storage/zip-export.js";

export interface AdminLogSource extends TaskQuerySource, ExportSource {
  cleanup(options: {
    taskIds?: string[];
    olderThanDays?: number;
    keepLatest?: number;
    batchSize?: number;
  }): Promise<unknown>;
}

export interface CleanupRequest {
  logRoots: readonly string[];
  taskIds?: string[];
  olderThanDays?: number;
  keepLatest?: number;
  batchSize?: number;
}

export class AdminLogService {
  readonly #sources: Map<string, AdminLogSource>;
  readonly #tasks: MultiRootTaskQuery;
  readonly #exporter: StreamingZipExporter;

  public constructor(sources: readonly AdminLogSource[], exporter = new StreamingZipExporter(2)) {
    this.#sources = new Map(sources.map((source) => [source.logRoot, source]));
    this.#tasks = new MultiRootTaskQuery(sources);
    this.#exporter = exporter;
  }

  public listTasks(query: string, limit: number, offset: number): Promise<MultiRootTaskPage> {
    return this.#tasks.list(query, limit, offset);
  }

  public async listRecords(logRoot: string, taskId: string, query: string, limit: number, offset: number) {
    const source = this.#source(logRoot);
    return RecordListResponseSchema.parse(await source.listRecords(taskId, limit, offset, query));
  }

  public async getRecord(logRoot: string, recordId: string) {
    const source = this.#source(logRoot);
    const result = await source.getRecord(recordId);
    return result === null ? null : RecordDetailSchema.parse(result);
  }

  public async cleanup(request: CleanupRequest) {
    const roots = [...new Set(request.logRoots)].sort();
    const settled = await Promise.all(
      roots.map(async (logRoot) => {
        try {
          const source = this.#source(logRoot);
          const result = await source.cleanup({
            ...(request.taskIds ? { taskIds: request.taskIds } : {}),
            ...(request.olderThanDays === undefined ? {} : { olderThanDays: request.olderThanDays }),
            ...(request.keepLatest === undefined ? {} : { keepLatest: request.keepLatest }),
            ...(request.batchSize === undefined ? {} : { batchSize: request.batchSize }),
          });
          return { ok: true as const, logRoot, result };
        } catch {
          return { ok: false as const, logRoot, code: "STORAGE_UNAVAILABLE" as const };
        }
      }),
    );
    return {
      results: settled.filter((value) => value.ok).map(({ logRoot, result }) => ({ logRoot, result })),
      failures: settled.filter((value) => !value.ok).map(({ logRoot, code }) => ({ logRoot, code })),
    };
  }

  public export(logRoot: string, query: string, signal: AbortSignal) {
    return this.#exporter.export(this.#source(logRoot), { query, signal });
  }

  #source(logRoot: string): AdminLogSource {
    const source = this.#sources.get(logRoot);
    if (!source) throw new LogRootNotFoundError();
    return source;
  }
}

export class LogRootNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = "LOG_ROOT_NOT_FOUND";

  public constructor() {
    super("Log root does not exist");
  }
}
