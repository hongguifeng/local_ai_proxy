import { TrafficRepository, type RecordRow, type TaskBriefRow } from "../persistence/index.js";
import type { SummaryModelConfig } from "../config/index.js";
import { stableHash } from "../proxy/protocol/analysis.js";
import {
  conflict,
  notFound,
  storageError,
  isRecord,
  type StructuredLogger,
} from "../shared/index.js";
import type { HistorySummary, TaskBrief } from "./log-query-service.js";
import {
  parseStoredBriefFacts,
  parseStoredTaskTimeline,
  parseStoredTimelineEvents,
  parseSummaryPayload,
  parseTaskTimelineAnswer,
  type TaskTimeline,
} from "./summary-answer.js";
import { prepareSummaryInput, prepareTaskTimelineInput } from "./summary-input.js";
import {
  SUMMARY_INSTRUCTION,
  SUMMARY_PROMPT_VERSION,
  TASK_BRIEF_INSTRUCTION,
  TASK_BRIEF_PROMPT_VERSION,
} from "./summary-prompts.js";
import { causeOf, errorName, summaryModelFailure } from "./summary-failure.js";
import type { SummaryModelGenerator } from "./summary-model-client.js";

/**
 * Generating a summary or a task brief, and remembering what was generated.
 *
 * Three responsibilities live here and nowhere else. The cache is the stored text:
 * a record summary is keyed by `records.id` and a task brief by `tasks.id`, and both
 * are read back from the root that holds the row. The concurrency guard is the set of
 * jobs currently in flight, keyed by the same ids, so a second request for a record
 * that is already being generated is refused instead of starting a second upstream
 * call. Storage is the write into the one root that owns the row, because a summary
 * or brief that references a record or task in another directory cannot be stored.
 *
 * What the model is sent, what it is asked, and how its answer is read are separate
 * modules; this one only decides when to call, where to remember the answer, and what
 * to do while an answer is still coming.
 */

export interface SummaryGenerationServiceOptions {
  /** The log roots to work in, resolved when an operation runs rather than once. */
  readonly logRoots: () => readonly string[];
  readonly logger: Pick<StructuredLogger, "warn">;
  readonly generator: SummaryModelGenerator;
}

export class SummaryGenerationService {
  readonly #logRoots: () => readonly string[];
  readonly #logger: Pick<StructuredLogger, "warn">;
  readonly #generator: SummaryModelGenerator;
  readonly #summaryJobs = new Map<string, Promise<HistorySummary | undefined>>();
  readonly #briefJobs = new Map<string, Promise<TaskBrief>>();

  constructor(options: SummaryGenerationServiceOptions) {
    this.#logRoots = options.logRoots;
    this.#logger = options.logger;
    this.#generator = options.generator;
  }

  /**
   * Generate a record's summary, store it, and hand back the model's own payload. A
   * record no log root holds answers `undefined` so the caller can say "no such record"
   * rather than pretend a summary was made. A second request for a record that is
   * already being generated is refused with a conflict.
   */
  async summarizeRecord(
    recordId: string,
    config: SummaryModelConfig,
  ): Promise<HistorySummary | undefined> {
    if (this.#summaryJobs.has(recordId))
      throw conflict("A summary is already being generated for this record.");
    const running = this.#generateSummary(recordId, config);
    this.#summaryJobs.set(recordId, running);
    try {
      return await running;
    } finally {
      this.#summaryJobs.delete(recordId);
    }
  }

  /**
   * The cached summary for a record, or undefined when none was ever generated. A root
   * that does not hold the record answers "no row" and is skipped without a log line.
   */
  cachedSummary(recordId: string): HistorySummary | undefined {
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        const summaryJson = repository.historySummaryJson(recordId);
        if (summaryJson !== undefined) {
          const parsed: unknown = JSON.parse(summaryJson);
          // Anything that is not an object cannot be a summary; the console shows it as absent.
          return isRecord(parsed) ? parsed : undefined;
        }
      } catch (error) {
        this.#logger.warn("Summary read failed", {
          phase: "history_summary_read",
          record_id: recordId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
        throw storageError("The summary could not be read.", {
          cause: error,
          details: { phase: "history_summary_read", record_id: recordId },
        });
      } finally {
        repository?.close();
      }
    }
    return undefined;
  }

  /**
   * Generate the task brief by sending the task's newest complete request to the
   * configured summary model. Manual only: nothing generates a brief until the user
   * asks for one, so no hidden model cost is incurred.
   */
  async generateTaskBrief(groupId: string, config: SummaryModelConfig): Promise<TaskBrief> {
    if (this.#briefJobs.has(groupId))
      throw conflict("A task brief is already being generated for this task.");
    const running = this.#generateBrief(groupId, config);
    this.#briefJobs.set(groupId, running);
    try {
      return await running;
    } finally {
      this.#briefJobs.delete(groupId);
    }
  }

  /**
   * The cached task brief: the overview, the evidence-backed timeline and the events the
   * timeline cites, or undefined when none was ever generated. Reading it never asks the
   * model anything - a stored answer is compared against the task's newest finished request
   * to say whether the source has moved on since it was written.
   */
  cachedBrief(taskId: string): TaskBrief | undefined {
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        const row = repository.getTaskBrief(taskId);
        if (row === undefined) continue;
        // An empty brief_text is the "never generated" answer, so the next root is asked.
        if (row.brief_text === null || row.brief_text === "") continue;
        return briefFromRow(row, taskId, isSourceStale(repository, row, taskId));
      } catch (error) {
        this.#logger.warn("Task brief read failed", {
          phase: "task_brief_read",
          task_id: taskId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
        throw storageError("The task brief could not be read.", {
          cause: error,
          details: { phase: "task_brief_read", task_id: taskId },
        });
      } finally {
        repository?.close();
      }
    }
    return undefined;
  }

  async #generateSummary(
    recordId: string,
    config: SummaryModelConfig,
  ): Promise<HistorySummary | undefined> {
    const record = this.#findRecord(recordId);
    // No record means no such record anywhere: the caller answers 404 rather than
    // pretending a summary was made.
    if (record === undefined) return undefined;
    const content = await this.#generator.generate(config, {
      instruction: SUMMARY_INSTRUCTION,
      input: prepareSummaryInput(record.request_body ?? null),
    });
    const summary = parseSummaryPayload(content);
    this.#storeSummary(recordId, summary, config.model);
    return summary;
  }

  async #generateBrief(groupId: string, config: SummaryModelConfig): Promise<TaskBrief> {
    const recordId = this.#latestRecordOfTask(groupId);
    if (recordId === undefined) throw notFound("Log group not found.");
    const record = this.#findRecord(recordId);
    // The row can go away between picking the newest finished request and reading it. A
    // timeline cannot be made from a source that is no longer there, so this is reported
    // instead of asking the model to explain an input with no events in it.
    if (record === undefined)
      throw summaryModelFailure("The newest request of this task is no longer in the log.");
    // The events are numbered by this server before the model sees them, so the order the
    // answer describes is the order the log has. `client` is still only the few request
    // headers that identify which agent is talking, so a client name stays evidence.
    const input = prepareTaskTimelineInput(record);
    const content = await this.#generator.generate(config, {
      instruction: TASK_BRIEF_INSTRUCTION,
      input: JSON.stringify(input),
    });
    const answer = parseTaskTimelineAnswer(content, input.source.event_count);
    return this.#storeBrief(groupId, answer, input, config.model, recordId);
  }

  /** The newest complete request of a task, or undefined when the task is unknown. */
  #latestRecordOfTask(groupId: string): string | undefined {
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        if (!repository.hasTask(groupId)) continue;
        const recordId = repository.latestTaskRecordId(groupId);
        if (recordId !== undefined) return recordId;
      } catch (error) {
        this.#logger.warn("Task brief source read failed", {
          phase: "task_brief_source_read",
          task_id: groupId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
        throw storageError("The task brief source could not be read.", {
          cause: error,
          details: { phase: "task_brief_source_read", task_id: groupId },
        });
      } finally {
        repository?.close();
      }
    }
    return undefined;
  }

  /**
   * The stored record a generation works on. A read that fails is not swallowed here:
   * it is the same failure the log listing would have hit, and hiding it would make a
   * broken log root look like a missing record.
   */
  #findRecord(recordId: string): Readonly<RecordRow> | undefined {
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        const record = repository.getRecord(recordId);
        if (record !== undefined) return record;
      } catch (error) {
        this.#logger.warn("Record read failed", {
          phase: "record_read",
          record_id: recordId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
        throw storageError("The record could not be read.", {
          cause: error,
          details: { phase: "record_read", record_id: recordId },
        });
      } finally {
        repository?.close();
      }
    }
    return undefined;
  }

  /**
   * Store the summary in the root that owns the record. Other roots cannot hold the row:
   * `history_summaries.record_id` references `records(id)`, so writing there is a foreign
   * key violation. A failure in the owning root is reported instead of dropped, because
   * the caller would otherwise show a summary that was never stored.
   */
  #storeSummary(recordId: string, summary: HistorySummary, model: string): void {
    let lastError: unknown;
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        if (!repository.hasRecord(recordId)) {
          continue;
        }
        repository.saveHistorySummary({
          recordId,
          summaryJson: JSON.stringify(summary),
          model,
          promptVersion: SUMMARY_PROMPT_VERSION,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return;
      } catch (error) {
        lastError = error;
        this.#logger.warn("Summary save failed", {
          phase: "history_summary_save",
          record_id: recordId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
      } finally {
        repository?.close();
      }
    }
    throw storageError("The summary could not be saved.", {
      ...(lastError === undefined ? {} : { cause: lastError }),
      details: { phase: "history_summary_save", record_id: recordId },
    });
  }

  #storeBrief(
    groupId: string,
    answer: {
      readonly overview: string;
      readonly timeline: TaskTimeline;
      readonly facts: Readonly<Record<string, string>>;
    },
    input: ReturnType<typeof prepareTaskTimelineInput>,
    model: string,
    sourceRecordId: string,
  ): TaskBrief {
    const contextJson =
      Object.keys(answer.facts).length === 0 ? null : JSON.stringify(answer.facts);
    let lastError: unknown;
    for (const root of this.#logRoots()) {
      let repository: TrafficRepository | undefined;
      try {
        repository = new TrafficRepository(root);
        // Only the root that owns the task can hold the brief: the row
        // references tasks(id), so writing it elsewhere is a foreign key
        // violation that would leave the brief in the wrong directory.
        if (!repository.hasTask(groupId)) continue;
        const saved = repository.saveTaskBrief({
          taskId: groupId,
          briefText: answer.overview,
          model,
          sourceRecordId,
          promptVersion: TASK_BRIEF_PROMPT_VERSION,
          contextJson,
          timelineJson: JSON.stringify(answer.timeline),
          sourceEventsJson: JSON.stringify(input.events),
          sourceSequence: input.source.request_sequence,
          // The fingerprint covers the whole prepared input - source block, client hints and
          // the numbered events - so it describes exactly what the model was shown.
          sourceFingerprint: stableHash(input, 16),
          sourceEventCount: input.source.event_count,
        });
        // A request that finished while this one was being generated makes the answer stale
        // as soon as it is stored; the console shows the old timeline and says why.
        return briefFromRow(saved, groupId, isSourceStale(repository, saved, groupId));
      } catch (error) {
        lastError = error;
        this.#logger.warn("Task brief save failed", {
          phase: "task_brief_save",
          task_id: groupId,
          log_root: root,
          error_type: errorName(error),
          cause_type: errorName(causeOf(error)),
        });
      } finally {
        repository?.close();
      }
    }
    throw storageError("The task brief could not be saved.", {
      ...(lastError === undefined ? {} : { cause: lastError }),
      details: { phase: "task_brief_save", task_id: groupId },
    });
  }
}

/**
 * Whether the stored answer still describes the task's newest finished request. The source
 * record id is the identity that changed when a new request landed, so a brief generated
 * while the task kept running reads back as stale without any model call being made.
 */
function isSourceStale(
  repository: TrafficRepository,
  row: Readonly<TaskBriefRow>,
  taskId: string,
): boolean {
  if (row.source_record_id === null) return false;
  return repository.latestTaskRecordId(taskId) !== row.source_record_id;
}

/**
 * The one place a `task_briefs` row becomes the brief the console shows. Callers first
 * drop a row whose `brief_text` is empty, which is how a generation that never finished
 * reads back; everything else here is present by construction.
 *
 * A row written before timelines existed has `timeline_json` null: it still shows its
 * paragraph and its facts, with no timeline and no events, and the card tells the user to
 * regenerate to get the steps.
 */
function briefFromRow(row: Readonly<TaskBriefRow>, groupId: string, stale: boolean): TaskBrief {
  const facts = parseStoredBriefFacts(row.context_json);
  const timeline = parseStoredTaskTimeline(row.timeline_json);
  const events = parseStoredTimelineEvents(row.source_events_json);
  return {
    task_id: groupId,
    text: row.brief_text ?? "",
    ...(timeline === undefined ? {} : { timeline }),
    ...(events === undefined ? {} : { events }),
    ...(facts === undefined ? {} : { context: facts }),
    // An empty model column means the brief was stored without a model name, which is
    // what the card shows as "no model".
    model: row.model === null || row.model === "" ? null : row.model,
    generated_at: row.updated_at,
    source_record_id: row.source_record_id,
    source_sequence: row.source_sequence,
    source_event_count: row.source_event_count,
    stale,
  };
}
