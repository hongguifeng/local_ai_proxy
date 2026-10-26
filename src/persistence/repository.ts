import type Database from "better-sqlite3";

import { localNowIso } from "../shared/index.js";
import { connectLogDatabase } from "./database.js";
import { GeneratedTextStore } from "./generated-text-store.js";
import { PricingStore } from "./pricing-store.js";
import { RecordStore } from "./record-store.js";
import { SearchStore, searchText } from "./search-store.js";
import { TaskStore } from "./task-store.js";
import type { RepositoryPage } from "./access-contracts.js";
import { integerValue } from "./column-codec.js";
import type { HistorySummaryWrite, TaskBriefRow, TaskBriefWrite } from "./generated-text-store.js";
import type {
  TaskCostSeriesPoint,
  TaskDecodeSpeedStats,
  TaskOutputTokenSeriesPoint,
  TaskPricingAggregate,
  TaskTokenSeriesPoint,
} from "./pricing-store.js";
import type {
  RecordRow,
  RecordSummaryRow,
  RecordWrite,
  UsageStatisticsRow,
} from "./record-store.js";
import type {
  TaskAssociationRow,
  TaskCandidateCriteria,
  TaskCandidatePage,
  TaskLinkRow,
  TaskRow,
  TaskSummaryRow,
  TaskWrite,
} from "./task-store.js";

/**
 * The traffic log's single entry point to SQLite.
 *
 * This module changes when the connection changes — how the log database is
 * opened, which user-defined functions the SQL may call, and what one business
 * write has to commit as a unit. The SQL itself lives in the access modules next
 * to the data they own: `task-store` (tasks and the identity links), `record-store`
 * (records and their bodies), `search-store` (the FTS index), `pricing-store` (the
 * money and timing aggregation) and `generated-text-store` (summary and brief
 * text). Each of those names one reason to change, so a change to one data area
 * stays in one file.
 *
 * `database` is the raw handle. Nothing in the business layer needs it: the
 * statements a caller used to write by hand are methods here now. It remains for
 * tests and tooling that must look at the stored file itself.
 */

export interface TrafficRepositoryOptions {
  readonly now?: () => string;
  /**
   * How long this connection may wait for a write lock before it reports the database as
   * busy. The default 5 seconds comes from `configureDatabase`; a reader that a console
   * polls every couple of seconds lowers it so a contended log fails fast and visibly
   * instead of holding the request open. A SQLite read is synchronous, so this wait is
   * the only timeout the connection can express.
   */
  readonly lockWaitMs?: number | undefined;
}

/** A response id a request answered, and the task that answered it. */
export interface ResponseLinkWrite {
  readonly responseId: string;
  readonly taskId: string;
}

/** A context key found in a request, and the task that carries it. */
export interface ContextLinkWrite {
  readonly contextKey: string;
  readonly taskId: string;
}

/**
 * One business write: everything that has to become visible together when the
 * proxy logs a request. The task, the record, the identity links and the search
 * row are one commit — either all of them are stored or none is, so a failed
 * write never leaves a group that has a task but no record, or a record no search
 * can find.
 */
export interface TrafficWrite {
  readonly task: Readonly<TaskWrite>;
  readonly record: Readonly<RecordWrite>;
  readonly responseLinks?: readonly ResponseLinkWrite[] | undefined;
  readonly contextLinks?: readonly ContextLinkWrite[] | undefined;
  /** Groups the matcher merged away; their rows go away with this commit. */
  readonly supersededTaskIds?: readonly string[] | undefined;
}

export { recordText } from "./access-contracts.js";
export type { RepositoryPage, RepositoryRecord } from "./access-contracts.js";
export { decodeRecordRow } from "./record-store.js";
export { decodeTaskRow } from "./task-store.js";
export type {
  TaskAssociationRow,
  TaskCandidateCriteria,
  TaskCandidatePage,
  TaskLinkRow,
} from "./task-store.js";
export { recordSearchDocument, searchText } from "./search-store.js";
export type { RecordSearchDocument } from "./search-store.js";
export type {
  PricingBucket,
  PricingPrice,
  TaskDecodeSpeedStats,
  TaskPricingAggregate,
  TaskPricingBreakdown,
  TaskPricingGroup,
} from "./pricing-store.js";
export type {
  HeaderMap,
  RecordPricing,
  RecordRow,
  RecordWrite,
  RecordWritePricing,
} from "./record-store.js";
export type { TaskRow, TaskSummaryRow } from "./task-store.js";

export class TrafficRepository {
  get database(): Database.Database {
    return this.#database;
  }
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #search: SearchStore;
  readonly #tasks: TaskStore;
  readonly #records: RecordStore;
  readonly #pricing: PricingStore;
  readonly #generated: GeneratedTextStore;

  constructor(logRoot: string, options: TrafficRepositoryOptions = {}) {
    this.#database = connectLogDatabase(logRoot);
    if (options.lockWaitMs !== undefined) {
      const waitMs = integerValue(options.lockWaitMs, 5_000);
      this.#database.pragma(`busy_timeout = ${Math.max(0, waitMs)}`);
    }
    this.#now = options.now ?? localNowIso;
    // The task listing searches the whole row, which only SQL can express. The
    // text is built here, in JavaScript, so the local-time form of a timestamp is
    // produced by the same function the console uses.
    this.#database.function("_search_text", { varargs: true }, (...values: unknown[]) =>
      searchText(...values),
    );
    this.#search = new SearchStore(this.#database);
    this.#tasks = new TaskStore(this.#database, this.#now, this.#search);
    this.#records = new RecordStore(this.#database, this.#now, this.#search, this.#tasks);
    this.#pricing = new PricingStore(this.#database);
    this.#generated = new GeneratedTextStore(this.#database, this.#now);
  }

  close(): void {
    this.#database.close();
  }

  transaction<T>(work: () => T): T {
    return this.#database.transaction(work)();
  }

  /**
   * Stores one logged request: its task, its record, the identity links that let
   * a later request continue it, and the search row that makes it findable — in
   * one commit. If any statement fails, none of it is stored.
   */
  writeTraffic(write: Readonly<TrafficWrite>): void {
    const commit = this.#database.transaction(() => {
      this.#tasks.write(write.task);
      const storedTask = this.#tasks.rawRow(write.task.id);
      this.#records.writeInside(write.record, storedTask);
      for (const link of write.responseLinks ?? []) {
        this.#tasks.linkResponse(link.responseId, link.taskId);
      }
      for (const link of write.contextLinks ?? []) {
        this.#tasks.linkContext(link.contextKey, link.taskId);
      }
      this.#tasks.removeInside(write.supersededTaskIds ?? []);
    });
    commit();
  }

  upsertTask(task: Readonly<TaskWrite>): TaskRow {
    return this.#tasks.write(task);
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.#tasks.get(taskId);
  }

  hasTask(taskId: string): boolean {
    return this.#tasks.has(taskId);
  }

  recentTasks(limit = 200): readonly TaskRow[] {
    return this.#tasks.recent(limit);
  }

  listTasks(query = "", limit = 100, offset = 0): RepositoryPage<TaskRow> {
    return this.#tasks.list(query, limit, offset);
  }

  listTaskSummaries(query = "", limit = 100, offset = 0): RepositoryPage<TaskSummaryRow> {
    return this.#tasks.listSummaries(query, limit, offset);
  }

  deleteTasks(taskIds: readonly string[]): number {
    return this.#tasks.remove(taskIds);
  }

  upsertResponseLink(responseId: string, taskId: string): void {
    this.#tasks.linkResponse(responseId, taskId);
  }

  taskIdForResponse(responseId: string): string | undefined {
    return this.#tasks.taskForResponse(responseId);
  }

  /**
   * The context links the given exact keys name, in one statement. Read-only: nothing
   * here writes a link, a task or a counter.
   */
  contextLinksForKeys(contextKeys: readonly string[]): readonly TaskLinkRow[] {
    return this.#tasks.contextLinksForKeys(contextKeys);
  }

  /** The response links the given response ids name, in one statement. */
  responseLinksForIds(responseIds: readonly string[]): readonly TaskLinkRow[] {
    return this.#tasks.responseLinksForIds(responseIds);
  }

  /** The named tasks as the association reader projects them; missing ids are skipped. */
  tasksForIds(taskIds: readonly string[]): readonly TaskAssociationRow[] {
    return this.#tasks.tasksForIds(taskIds);
  }

  /**
   * Bounded boundary candidates of one endpoint kind and model, newest first. `truncated`
   * says a row was still waiting past the cap, so a caller never mistakes a partial scan
   * for the whole history.
   */
  taskBoundaryCandidates(criteria: Readonly<TaskCandidateCriteria>): TaskCandidatePage {
    return this.#tasks.boundaryCandidates(criteria);
  }

  /** The newest record timestamp this log holds, or null when it holds no record. */
  newestRecordTimestamp(): string | null {
    return this.#records.newestTimestamp();
  }

  upsertContextLink(contextKey: string, taskId: string): void {
    this.#tasks.linkContext(contextKey, taskId);
  }

  taskIdForContext(contextKey: string): string | undefined {
    return this.#tasks.taskForContext(contextKey);
  }

  upsertRecord(record: Readonly<RecordWrite>): RecordRow {
    return this.#records.write(record);
  }

  getRecord(recordId: string): RecordRow | undefined {
    return this.#records.get(recordId);
  }

  /** Whether this log holds a record with that id. */
  hasRecord(recordId: string): boolean {
    return this.#records.has(recordId);
  }

  taskIdForRecord(recordId: string): string | undefined {
    return this.#records.taskIdFor(recordId);
  }

  nextRecordSequence(taskId: string): number {
    return this.#records.nextSequence(taskId);
  }

  recordCount(taskId: string): number {
    return this.#records.recordCount(taskId);
  }

  markPendingPricingInterrupted(now = new Date().toISOString()): number {
    return this.#records.markPendingPricingInterrupted(now);
  }

  taskPricing(taskId: string): TaskPricingAggregate | undefined {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return undefined;
    const aggregate = this.#pricing.forTasks([taskId]).get(taskId);
    return aggregate === undefined ? undefined : { ...aggregate, target: task.target };
  }

  taskPricingForTasks(taskIds: readonly string[]): Map<string, TaskPricingAggregate> {
    return this.#pricing.forTasks(taskIds);
  }

  /**
   * Per-request token counts for the task-detail chart, ordered by request
   * sequence. Undefined when no task has that id.
   */
  taskTokenSeries(taskId: string): readonly TaskTokenSeriesPoint[] | undefined {
    if (this.#tasks.get(taskId) === undefined) return undefined;
    return this.#pricing.tokenSeries(taskId);
  }

  /**
   * Per-request cost for the task-detail chart, ordered by request sequence.
   * Undefined when no task has that id.
   */
  taskCostSeries(taskId: string): readonly TaskCostSeriesPoint[] | undefined {
    if (this.#tasks.get(taskId) === undefined) return undefined;
    return this.#pricing.costSeries(taskId);
  }

  /**
   * Per-request output tokens for the task-detail chart, ordered by request
   * sequence. Undefined when no task has that id.
   */
  taskOutputTokenSeries(taskId: string): readonly TaskOutputTokenSeriesPoint[] | undefined {
    if (this.#tasks.get(taskId) === undefined) return undefined;
    return this.#pricing.outputTokenSeries(taskId);
  }

  taskDecodeSpeedStats(taskIds: readonly string[]): Map<string, TaskDecodeSpeedStats> {
    return this.#pricing.decodeSpeedStats(taskIds);
  }

  listTaskRecords(taskId: string, query = "", limit = 200, offset = 0): RepositoryPage<RecordRow> {
    return this.#records.listForTask(taskId, query, limit, offset);
  }

  listTaskRecordSummaries(
    taskId: string,
    query = "",
    limit = 200,
    offset = 0,
  ): RepositoryPage<RecordSummaryRow> {
    return this.#records.listSummariesForTask(taskId, query, limit, offset);
  }

  /**
   * Body-free rows for the given record ids, so the admin pending sweep can
   * refresh in-flight records without decoding their bodies.
   */
  listRecordsByIds(ids: readonly string[], limit = 200): readonly RecordSummaryRow[] {
    return this.#records.listByIds(ids, limit);
  }

  /** The first matching records of each listed group, for the search preview. */
  listTaskSearchPreviews(
    taskIds: readonly string[],
    query: string,
    limit = 20,
  ): Map<string, RepositoryPage<RecordSummaryRow>> {
    return this.#search.previews(taskIds, query, limit);
  }

  /**
   * The newest record of a task whose body is complete, i.e. the last finished
   * request. Falls back to the newest record at all when every request of the
   * task is still in flight, so a running task can still be briefed.
   */
  latestTaskRecordId(taskId: string): string | undefined {
    return this.#records.latestFinishedId(taskId);
  }

  /** The stored summary of a record, as the model wrote it, or undefined when none exists. */
  historySummaryJson(recordId: string): string | undefined {
    return this.#generated.summaryJson(recordId);
  }

  /** Stores the summary of a record in this log. */
  saveHistorySummary(summary: Readonly<HistorySummaryWrite>): void {
    this.#generated.saveSummary(summary);
  }

  getTaskBrief(taskId: string): TaskBriefRow | undefined {
    return this.#generated.brief(taskId);
  }

  saveTaskBrief(brief: Readonly<TaskBriefWrite>): TaskBriefRow {
    return this.#generated.saveBrief(brief);
  }

  /** Returns lightweight rows for usage statistics; body columns are intentionally omitted. */
  usageStatisticsRows(from: string, to: string): readonly UsageStatisticsRow[] {
    return this.#records.usageStatisticsRows(from, to);
  }
}
