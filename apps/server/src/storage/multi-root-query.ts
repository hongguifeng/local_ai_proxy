import { TaskListResponseSchema, type TaskSummary } from "@llm-proxy/contracts";

export interface TaskQuerySource {
  logRoot: string;
  listTasks(query: string, limit: number, offset: number): Promise<unknown>;
}

export interface MultiRootTask {
  logRoot: string;
  task: TaskSummary;
}

export interface QueryFailure {
  logRoot: string;
  code: "STORAGE_UNAVAILABLE" | "INVALID_STORAGE_RESPONSE";
}

export interface MultiRootTaskPage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  tasks: MultiRootTask[];
  failures: QueryFailure[];
}

export class MultiRootTaskQuery {
  readonly #sources: readonly TaskQuerySource[];

  public constructor(sources: readonly TaskQuerySource[]) {
    this.#sources = [...sources].sort((left, right) => left.logRoot.localeCompare(right.logRoot));
  }

  public async list(query: string, limit = 50, offset = 0): Promise<MultiRootTaskPage> {
    assertPagination(limit, offset);
    const wanted = offset + limit;
    const results = await Promise.all(this.#sources.map(async (source) => fetchSource(source, query, wanted)));
    const tasks: MultiRootTask[] = [];
    const failures: QueryFailure[] = [];
    let total = 0;
    for (const result of results) {
      if ("failure" in result) failures.push(result.failure);
      else {
        total += result.total;
        tasks.push(...result.tasks);
      }
    }
    tasks.sort(compareTasks);
    return {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      tasks: tasks.slice(offset, wanted),
      failures,
    };
  }
}

async function fetchSource(
  source: TaskQuerySource,
  query: string,
  wanted: number,
): Promise<{ total: number; tasks: MultiRootTask[] } | { failure: QueryFailure }> {
  const tasks: MultiRootTask[] = [];
  let total = 0;
  try {
    while (tasks.length < wanted) {
      const page = TaskListResponseSchema.safeParse(
        await source.listTasks(query, Math.min(200, wanted - tasks.length), tasks.length),
      );
      if (!page.success) return { failure: { logRoot: source.logRoot, code: "INVALID_STORAGE_RESPONSE" } };
      total = page.data.total;
      tasks.push(...page.data.tasks.map((task) => ({ logRoot: source.logRoot, task })));
      if (!page.data.hasMore || page.data.tasks.length === 0) break;
    }
    return { total, tasks };
  } catch {
    return { failure: { logRoot: source.logRoot, code: "STORAGE_UNAVAILABLE" } };
  }
}

function compareTasks(left: MultiRootTask, right: MultiRootTask): number {
  return (
    right.task.lastSeenAt.localeCompare(left.task.lastSeenAt) ||
    left.task.id.localeCompare(right.task.id) ||
    left.logRoot.localeCompare(right.logRoot)
  );
}

function assertPagination(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Invalid limit");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new RangeError("Invalid offset");
}
