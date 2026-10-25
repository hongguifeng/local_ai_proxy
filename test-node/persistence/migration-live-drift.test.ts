import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectLogDatabase,
  openLogDatabase,
  runMigrations,
} from "../../src/persistence/database.js";
import { frozenResponseTokenCounts } from "../../src/persistence/schema-v5.js";
import { SCHEMA_V1_MIGRATION } from "../../src/persistence/schema-v1.js";
import { SCHEMA_V2_MIGRATION } from "../../src/persistence/schema-v2.js";
import { SCHEMA_V3_MIGRATION } from "../../src/persistence/schema-v3.js";
import { SCHEMA_V4_MIGRATION } from "../../src/persistence/schema-v4.js";
import { responseTokenCounts } from "../../src/proxy/records.js";

/**
 * [AI-13] runs a real v4 database through the v5 upgrade while the current protocol counting path
 * is deliberately changed. The live answer must move; the upgrade result must not.
 *
 * The change is made by replacing `isPythonTruthy` - a predicate the live counting path reads from
 * `src/proxy/protocol/analysis.ts` - with a rule that calls an empty usage object present. That is
 * the kind of edit protocol work makes: it changes which `usage` block a response body is read as.
 * It is applied through the module registry rather than by editing the live file, because that file
 * belongs to another task. If the migration ever goes back to reading live protocol code, the
 * upgrade result below moves and this test fails.
 */

vi.mock("../../src/proxy/protocol/analysis.js", async () => {
  const actual = await import("../../src/proxy/protocol/analysis.js");
  return {
    ...actual,
    isPythonTruthy: (value: unknown): boolean => value !== null && value !== undefined,
  };
});

/** A body whose stream summary carries an empty usage object in front of a real one. */
const AMBIGUOUS_BODY = JSON.stringify({
  stream_summary: { usage: {} },
  usage: { input_tokens: 5, output_tokens: 2 },
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function writeV4Database(): Promise<string> {
  const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-live-drift-"));
  temporaryDirectories.push(logRoot);
  const database = openLogDatabase(logRoot);
  try {
    runMigrations(database, [SCHEMA_V1_MIGRATION, SCHEMA_V2_MIGRATION]);
    database
      .prepare(
        `
        INSERT INTO tasks(
          id, kind, started_at, last_seen_at, match_strategy_version, created_at, updated_at
        ) VALUES (?, 'responses', ?, ?, 4, ?, ?)
      `,
      )
      .run("task-drift", "2026-07-18", "2026-07-18", "2026-07-18", "2026-07-18");
    database
      .prepare(
        `
        INSERT INTO records(
          id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
          token_count, response_body_json, created_at, updated_at
        ) VALUES (?, ?, 1, 'request_finished', ?, ?, 'POST', '/v1/responses', '/v1/responses',
          ?, ?, ?, ?)
      `,
      )
      .run(
        "record-drift",
        "task-drift",
        "2026-07-18",
        "2026-07-18",
        7,
        AMBIGUOUS_BODY,
        "2026-07-18",
        "2026-07-18",
      );
    // A database this old has its bodies moved out of the inline columns by v3, so the rows are
    // written before that migration runs and after the two that only add tables and a column.
    runMigrations(database, [SCHEMA_V3_MIGRATION, SCHEMA_V4_MIGRATION]);
  } finally {
    database.close();
  }
  return logRoot;
}

function readTokenCounts(logRoot: string): { request: unknown; response: unknown } {
  const database = connectLogDatabase(logRoot);
  try {
    return database
      .prepare(
        `SELECT request_token_count AS request, response_token_count AS response
         FROM records WHERE id = 'record-drift'`,
      )
      .get() as { request: unknown; response: unknown };
  } finally {
    database.close();
  }
}

describe("[AI-13] the current counting path cannot move the v5 upgrade", () => {
  it("moves the live answer but not the upgraded record", async () => {
    const payload = JSON.parse(AMBIGUOUS_BODY) as unknown;

    // The live counting path, with its predicate changed, no longer reads this body as a
    // 5-in/2-out request: the empty stream-summary usage now wins and carries nothing. Had the
    // upgrade still depended on it, the two columns would have stayed NULL.
    expect(responseTokenCounts(payload)).toEqual({ request: undefined, response: undefined });
    // The migration's own copy does not read that predicate, so it still reads the same body.
    expect(frozenResponseTokenCounts(payload)).toEqual({ request: 5, response: 2 });

    const logRoot = await writeV4Database();

    expect(readTokenCounts(logRoot)).toEqual({ request: 5, response: 2 });
    // Reopening an already-migrated database must not re-run the conversion.
    expect(readTokenCounts(logRoot)).toEqual({ request: 5, response: 2 });
  });
});
