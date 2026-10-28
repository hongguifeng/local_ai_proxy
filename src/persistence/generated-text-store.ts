import type Database from "better-sqlite3";

/**
 * The text a summary model wrote about stored traffic: per-record summaries and
 * per-task briefs.
 *
 * This module changes when generated text is stored differently — a new prompt
 * version column, a different status set, a context block that travels with a
 * brief. It owns `history_summaries` and `task_briefs`; the record and task rows
 * those tables point at are read-only here and deleting a record or task cascades
 * the generated row away.
 */

/** The three states a generated document can be in. */
export type GeneratedTextStatus = "pending" | "ready" | "failed";

/** One task brief the repository is asked to store. */
export interface TaskBriefWrite {
  readonly taskId: string;
  readonly briefText: string;
  readonly model: string;
  readonly sourceRecordId: string;
  readonly promptVersion: string;
  /** The environment facts the summary model read out of the newest request. */
  readonly contextJson?: string | null | undefined;
  /** The checked `{overview,steps,gaps}`, never the model's raw text. */
  readonly timelineJson?: string | null | undefined;
  /** The server-normalized evidence events the timeline was made from. */
  readonly sourceEventsJson?: string | null | undefined;
  /** The `sequence` the source record had inside its task. */
  readonly sourceSequence?: number | null | undefined;
  /**
   * A fingerprint of the normalized input the answer was checked against. It travels with
   * the row so a source change can be told apart later; the staleness label compares record
   * ids instead, because re-deriving this fingerprint needs the request body decoded.
   */
  readonly sourceFingerprint?: string | null | undefined;
  /** How many events the normalized input carried. */
  readonly sourceEventCount?: number | null | undefined;
}

/** A stored task brief, as the console reads it. */
export interface TaskBriefRowFields {
  readonly task_id: string;
  readonly status: GeneratedTextStatus;
  readonly brief_text: string | null;
  readonly source_record_id: string | null;
  readonly model: string | null;
  readonly prompt_version: string;
  readonly context_json: string | null;
  readonly timeline_json: string | null;
  readonly source_events_json: string | null;
  readonly source_sequence: number | null;
  readonly source_fingerprint: string | null;
  readonly source_event_count: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error_message: string | null;
}

/** One stored task brief. The unmodelled half holds columns an older library kept. */
export type TaskBriefRow = TaskBriefRowFields & Record<string, unknown>;

/** One summary the repository is asked to store. */
export interface HistorySummaryWrite {
  readonly recordId: string;
  /** The summary model's own JSON, kept verbatim. */
  readonly summaryJson: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class GeneratedTextStore {
  readonly #database: Database.Database;
  readonly #now: () => string;

  constructor(database: Database.Database, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * The generated one-paragraph task brief for a task, or undefined when it was
   * never generated (or the generation did not finish).
   */
  brief(taskId: string): TaskBriefRow | undefined {
    return this.#database
      .prepare("SELECT * FROM task_briefs WHERE task_id = ? AND status = 'ready'")
      .get(taskId) as TaskBriefRow | undefined;
  }

  /** Stores the brief of a task, overwriting the one row that already exists. */
  saveBrief(brief: Readonly<TaskBriefWrite>): TaskBriefRow {
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO task_briefs(task_id,status,brief_text,source_record_id,model,prompt_version,context_json,
           timeline_json,source_events_json,source_sequence,source_fingerprint,source_event_count,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           status='ready',
           brief_text=excluded.brief_text,
           source_record_id=excluded.source_record_id,
           model=excluded.model,
           prompt_version=excluded.prompt_version,
           context_json=excluded.context_json,
           timeline_json=excluded.timeline_json,
           source_events_json=excluded.source_events_json,
           source_sequence=excluded.source_sequence,
           source_fingerprint=excluded.source_fingerprint,
           source_event_count=excluded.source_event_count,
           updated_at=excluded.updated_at`,
      )
      .run(
        brief.taskId,
        "ready",
        brief.briefText,
        brief.sourceRecordId,
        brief.model,
        brief.promptVersion,
        brief.contextJson ?? null,
        brief.timelineJson ?? null,
        brief.sourceEventsJson ?? null,
        brief.sourceSequence ?? null,
        brief.sourceFingerprint ?? null,
        brief.sourceEventCount ?? null,
        now,
        now,
      );
    const saved = this.brief(brief.taskId);
    if (saved === undefined) {
      throw new Error(`Task brief for ${brief.taskId} was not saved.`);
    }
    return saved;
  }

  /**
   * The summary JSON stored for a record, or undefined when none was ever
   * generated. The text is handed back unparsed: the reader decides what is a
   * summary and what is a leftover from a model that answered badly.
   */
  summaryJson(recordId: string): string | undefined {
    const row = this.#database
      .prepare(
        "SELECT summary_json FROM history_summaries WHERE record_id = ? AND status = 'ready'",
      )
      .get(recordId) as { summary_json?: string } | undefined;
    const stored = row?.summary_json;
    return stored === undefined || stored === "" ? undefined : stored;
  }

  /** Stores the summary of a record, overwriting the one row that already exists. */
  saveSummary(summary: Readonly<HistorySummaryWrite>): void {
    this.#database
      .prepare(
        "INSERT INTO history_summaries(record_id,status,summary_json,model,prompt_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET status='ready',summary_json=excluded.summary_json,model=excluded.model,updated_at=excluded.updated_at",
      )
      .run(
        summary.recordId,
        "ready",
        summary.summaryJson,
        summary.model,
        summary.promptVersion,
        summary.createdAt,
        summary.updatedAt,
      );
  }
}
