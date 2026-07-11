import {
  ProxyListResponseSchema,
  RecordDetailSchema,
  RecordListResponseSchema,
  TaskListResponseSchema,
  type ProxyListResponse,
  type RecordDetail,
  type RecordListResponse,
  type TaskSummary,
} from "@llm-proxy/contracts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiClient {
  readonly #fetch: FetchLike;

  public constructor(fetcher: FetchLike = (input, init) => fetch(input, init)) {
    this.#fetch = fetcher;
  }

  public async proxies(signal?: AbortSignal): Promise<ProxyListResponse> {
    return ProxyListResponseSchema.parse(await this.#json("/api/v1/proxies", signalInit(signal)));
  }

  public async replaceProxies(body: unknown, signal?: AbortSignal): Promise<ProxyListResponse> {
    return ProxyListResponseSchema.parse(await this.#json("/api/v1/proxies", jsonRequest("PUT", body, signal)));
  }

  public async setProxyEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<ProxyListResponse> {
    return ProxyListResponseSchema.parse(
      await this.#json(`/api/v1/proxies/${encodeURIComponent(id)}/enabled`, jsonRequest("POST", { enabled }, signal)),
    );
  }

  public async tasks(query = "", limit = 50, offset = 0, signal?: AbortSignal): Promise<TaskPage> {
    const raw = await this.#json(`/api/v1/tasks?${params({ query, limit, offset })}`, signalInit(signal));
    if (!raw || typeof raw !== "object" || !("tasks" in raw) || !Array.isArray(raw.tasks))
      throw new TypeError("Invalid task response");
    const entries: unknown[] = raw.tasks;
    const core = TaskListResponseSchema.parse({
      total: "total" in raw ? raw.total : undefined,
      limit: "limit" in raw ? raw.limit : undefined,
      offset: "offset" in raw ? raw.offset : undefined,
      hasMore: "hasMore" in raw ? raw.hasMore : undefined,
      tasks: entries.map(taskEntry),
    });
    const roots = entries.map((entry) => logRootEntry(entry));
    return {
      ...core,
      tasks: core.tasks.map((task, index) => ({ task, logRoot: roots[index] ?? "" })),
      failures: failures(raw),
    };
  }

  public async records(
    logRoot: string,
    taskId: string,
    query = "",
    limit = 50,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<RecordListResponse> {
    return RecordListResponseSchema.parse(
      await this.#json(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/records?${params({ logRoot, query, limit, offset })}`,
        signalInit(signal),
      ),
    );
  }

  public async record(logRoot: string, recordId: string, signal?: AbortSignal): Promise<RecordDetail> {
    return RecordDetailSchema.parse(
      await this.#json(`/api/v1/records/${encodeURIComponent(recordId)}?${params({ logRoot })}`, signalInit(signal)),
    );
  }

  public async cleanup(body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.#json("/api/v1/tasks/cleanup", jsonRequest("POST", body, signal));
  }

  public exportUrl(logRoot: string, query = ""): string {
    return `/api/v1/tasks/export?${params({ logRoot, query })}`;
  }

  async #json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(path, init);
    const body = (await response.json()) as unknown;
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  }
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly response: unknown;

  public constructor(status: number, response: unknown) {
    super("API request failed");
    this.status = status;
    this.response = response;
  }
}

export interface TaskPage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  tasks: { task: TaskSummary; logRoot: string }[];
  failures: { logRoot: string; code: string }[];
}

function jsonRequest(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal ? { signal } : {};
}

function params(values: Record<string, string | number>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== "") result.set(key, String(value));
  return result.toString();
}

function taskEntry(value: unknown): unknown {
  return value && typeof value === "object" && "task" in value ? value.task : value;
}

function logRootEntry(value: unknown): string {
  return value && typeof value === "object" && "logRoot" in value && typeof value.logRoot === "string"
    ? value.logRoot
    : "";
}

function failures(value: object): { logRoot: string; code: string }[] {
  if (!("failures" in value) || !Array.isArray(value.failures)) return [];
  const values: unknown[] = value.failures;
  return values.flatMap((failure) =>
    failure &&
    typeof failure === "object" &&
    "logRoot" in failure &&
    typeof failure.logRoot === "string" &&
    "code" in failure &&
    typeof failure.code === "string"
      ? [{ logRoot: failure.logRoot, code: failure.code }]
      : [],
  );
}
