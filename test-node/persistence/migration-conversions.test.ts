import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  DATABASE_MIGRATIONS,
  connectLogDatabase,
  openLogDatabase,
  readSchemaVersion,
  runMigrations,
  type DatabaseMigration,
} from "../../src/persistence/database.js";
import { loadRecordBody } from "../../src/persistence/body-storage.js";
import { TrafficRepository } from "../../src/persistence/repository.js";
import { SCHEMA_V1_MIGRATION } from "../../src/persistence/schema-v1.js";
import { SCHEMA_V2_MIGRATION } from "../../src/persistence/schema-v2.js";
import { SCHEMA_V3_MIGRATION } from "../../src/persistence/schema-v3.js";
import { SCHEMA_V4_MIGRATION } from "../../src/persistence/schema-v4.js";
import { SCHEMA_V5_MIGRATION, SCHEMA_V5_VERSION } from "../../src/persistence/schema-v5.js";
import { SCHEMA_V6_MIGRATION } from "../../src/persistence/schema-v6.js";
import { SCHEMA_V7_MIGRATION } from "../../src/persistence/schema-v7.js";
import { SCHEMA_V8_MIGRATION } from "../../src/persistence/schema-v8.js";
import { validateMigrationDatabase } from "../../scripts/validate_migration.js";

/**
 * [AI-13] follows the old comprehensive fixture from schema version 1 to the current one and asks,
 * for every conversion the chain performs, whether stored meaning survived: the token counts v5
 * derives, the body bytes v3 moves, the search text v3 copies, the money v8 introduces, the
 * relations between tasks, records and links, and what a failure inside a conversion leaves behind.
 */

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "parity",
  "database",
  "comprehensive",
  "traffic.db",
);

/** The tables a database at the current version has, and nothing else. */
const CURRENT_TABLE_NAMES: readonly string[] = [
  "body_chunks",
  "context_links",
  "history_summaries",
  "record_body_chunks",
  "record_search_fts",
  "record_search_fts_config",
  "record_search_fts_data",
  "record_search_fts_docsize",
  "record_search_fts_idx",
  "record_search_map",
  "records",
  "response_links",
  "schema_meta",
  "task_briefs",
  "tasks",
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

/** A private copy of the old fixture; the real one is never written to. */
async function copyFixture(): Promise<string> {
  const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-ai13-upgrade-"));
  temporaryDirectories.push(logRoot);
  await copyFile(FIXTURE_PATH, path.join(logRoot, "traffic.db"));
  return logRoot;
}

function tableNames(database: Database.Database): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

function recordTokenRows(database: Database.Database): unknown[] {
  return database
    .prepare(
      `SELECT id, token_count, request_token_count, response_token_count
       FROM records ORDER BY id`,
    )
    .all();
}

function recordPricingRows(database: Database.Database): unknown[] {
  return database
    .prepare(
      `SELECT id, pricing_status, pricing_reason, CAST(cost_nano_cny AS TEXT) AS cost_text
       FROM records ORDER BY id`,
    )
    .all();
}

/** The inline body text of a database that has not been through the v3 conversion yet. */
function inlineBodies(
  database: Database.Database,
): { id: string; request: string | null; response: string | null }[] {
  return database
    .prepare(
      `SELECT id, request_body_json AS request, response_body_json AS response
       FROM records ORDER BY id`,
    )
    .all() as { id: string; request: string | null; response: string | null }[];
}

function recordsFingerprint(database: Database.Database): string {
  return JSON.stringify(database.prepare("SELECT * FROM records ORDER BY id").all());
}

function tasksFingerprint(database: Database.Database): string {
  return JSON.stringify(database.prepare("SELECT * FROM tasks ORDER BY id").all());
}

function orphanCount(database: Database.Database, sql: string): number {
  return database.prepare(sql).pluck().get() as number;
}

describe("[AI-13] upgrading the old fixture to the current schema", () => {
  it("converts the stored bodies into the token counts v5 was written to produce", async () => {
    const logRoot = await copyFixture();
    const database = connectLogDatabase(logRoot);

    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(database)).toEqual(CURRENT_TABLE_NAMES);
    expect(
      (database.pragma("table_info(records)") as { name: string; type: string }[])
        .filter(({ name }) =>
          ["request_token_count", "response_token_count", "cost_nano_cny"].includes(name),
        )
        .map(({ type }) => type),
    ).toEqual(["INTEGER", "INTEGER", "INTEGER"]);

    // The key converted values, written out one by one: every body the v5 backfill reads has its
    // counts here, including the two bodies that carry only `total_tokens` and must stay NULL.
    expect(recordTokenRows(database)).toEqual([
      {
        id: "record-chat-1",
        token_count: 12,
        request_token_count: 7,
        response_token_count: 5,
      },
      {
        id: "record-completions-1",
        token_count: 6,
        request_token_count: null,
        response_token_count: null,
      },
      {
        id: "record-messages-1",
        token_count: 19,
        request_token_count: 13,
        response_token_count: 6,
      },
      {
        id: "record-pending-1",
        token_count: null,
        request_token_count: null,
        response_token_count: null,
      },
      {
        id: "record-responses-1",
        token_count: 20,
        request_token_count: 12,
        response_token_count: 8,
      },
      {
        id: "record-responses-2",
        token_count: 9,
        request_token_count: null,
        response_token_count: null,
      },
    ]);

    // The total a record already carried is never recomputed, and the upgrade stamps history as
    // legacy without inventing a price for it.
    expect(recordPricingRows(database)).toEqual([
      {
        id: "record-chat-1",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
      {
        id: "record-completions-1",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
      {
        id: "record-messages-1",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
      {
        id: "record-pending-1",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
      {
        id: "record-responses-1",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
      {
        id: "record-responses-2",
        pricing_status: "unpriced",
        pricing_reason: "legacy_record",
        cost_text: null,
      },
    ]);

    database.close();
  });

  it("moves request and response bodies without changing a byte of them", async () => {
    const logRoot = await copyFixture();
    const before = new Database(path.join(logRoot, "traffic.db"), {
      fileMustExist: true,
      readonly: true,
    });
    const inlineBefore = inlineBodies(before);
    before.close();

    const database = connectLogDatabase(logRoot);
    for (const { id, request, response } of inlineBefore) {
      expect(loadRecordBody(database, id, "request")).toBe(request);
      expect(loadRecordBody(database, id, "response")).toBe(response);
      // A body kind the old database never had stays absent, not an empty string.
      expect(loadRecordBody(database, id, "original_request")).toBeNull();
    }
    expect(
      database
        .prepare(
          `SELECT COUNT(*) FROM records
           WHERE request_body_json IS NOT NULL
              OR original_request_body_json IS NOT NULL
              OR response_body_json IS NOT NULL`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    // Only the two kinds this database ever had bodies for have chunk rows; the third stays
    // absent above and here.
    expect(
      database
        .prepare("SELECT DISTINCT body_kind FROM record_body_chunks ORDER BY body_kind")
        .pluck()
        .all(),
    ).toEqual(["request", "response"]);
    database.close();
  });

  it("keeps every relation and the searchable text of the old database", async () => {
    const logRoot = await copyFixture();
    const before = new Database(path.join(logRoot, "traffic.db"), {
      fileMustExist: true,
      readonly: true,
    });
    const linksBefore = {
      responseLinks: before
        .prepare("SELECT response_id, task_id FROM response_links ORDER BY response_id")
        .all(),
      contextLinks: before
        .prepare("SELECT context_key, task_id FROM context_links ORDER BY context_key")
        .all(),
    };
    before.close();

    const database = connectLogDatabase(logRoot);
    const validation = validateMigrationDatabase(logRoot);
    expect(validation.counts).toEqual({
      tasks: 5,
      records: 6,
      response_links: 2,
      context_links: 2,
      record_search: 6,
    });
    expect(validation.orphanCounts).toEqual({
      records: 0,
      response_links: 0,
      context_links: 0,
      record_search: 0,
    });

    expect(
      database
        .prepare("SELECT response_id, task_id FROM response_links ORDER BY response_id")
        .all(),
    ).toEqual(linksBefore.responseLinks);
    expect(
      database.prepare("SELECT context_key, task_id FROM context_links ORDER BY context_key").all(),
    ).toEqual(linksBefore.contextLinks);

    // The search rows v3 copies keep pointing at a record and a task that both exist.
    expect(
      orphanCount(
        database,
        `SELECT COUNT(*) FROM record_search_map m
         LEFT JOIN records r ON r.id = m.record_id
         LEFT JOIN tasks t ON t.id = m.task_id
         WHERE r.id IS NULL OR t.id IS NULL`,
      ),
    ).toBe(0);
    // The copied text still matches, so the copy is not a rewrite of what was searchable.
    expect(
      database
        .prepare(
          `SELECT m.record_id FROM record_search_map AS m
           JOIN record_search_fts ON record_search_fts.rowid = m.search_rowid
           WHERE record_search_fts MATCH ? ORDER BY m.record_id`,
        )
        .pluck()
        .all("fixture"),
    ).toEqual([
      "record-chat-1",
      "record-completions-1",
      "record-messages-1",
      "record-pending-1",
      "record-responses-1",
      "record-responses-2",
    ]);
    database.close();
  });

  it("changes nothing when an already-upgraded database is reopened", async () => {
    const logRoot = await copyFixture();
    const first = connectLogDatabase(logRoot);
    const snapshot = {
      version: readSchemaVersion(first),
      tables: tableNames(first),
      tokens: recordTokenRows(first),
      pricing: recordPricingRows(first),
      records: recordsFingerprint(first),
      tasks: tasksFingerprint(first),
      chunks: first.prepare("SELECT COUNT(*) FROM record_body_chunks").pluck().get(),
      searchRows: first.prepare("SELECT COUNT(*) FROM record_search_map").pluck().get(),
    };
    first.close();

    const repository = new TrafficRepository(logRoot);
    repository.close();
    const reopened = connectLogDatabase(logRoot);

    expect(readSchemaVersion(reopened)).toBe(snapshot.version);
    expect(tableNames(reopened)).toEqual(snapshot.tables);
    expect(recordTokenRows(reopened)).toEqual(snapshot.tokens);
    expect(recordPricingRows(reopened)).toEqual(snapshot.pricing);
    expect(recordsFingerprint(reopened)).toBe(snapshot.records);
    expect(tasksFingerprint(reopened)).toBe(snapshot.tasks);
    expect(reopened.prepare("SELECT COUNT(*) FROM record_body_chunks").pluck().get()).toBe(
      snapshot.chunks,
    );
    expect(reopened.prepare("SELECT COUNT(*) FROM record_search_map").pluck().get()).toBe(
      snapshot.searchRows,
    );
    reopened.close();
  });
});

describe("[AI-13] a conversion that fails leaves nothing half-built", () => {
  it("rolls the whole upgrade back when the v5 token backfill is interrupted", async () => {
    const logRoot = await copyFixture();
    const database = openLogDatabase(logRoot);
    const recordsBefore = recordsFingerprint(database);
    const tasksBefore = tasksFingerprint(database);

    // One entry of the real chain is replaced by an implementation of the same version that stops
    // partway; the versions below it still run for real, so the failure lands on the v5 step.
    const interrupted: DatabaseMigration[] = DATABASE_MIGRATIONS.map((migration) =>
      migration.version === SCHEMA_V5_VERSION
        ? {
            version: SCHEMA_V5_VERSION,
            migrate: () => {
              throw new Error("v5 token backfill interrupted");
            },
          }
        : migration,
    );

    expect(() => runMigrations(database, interrupted)).toThrow("v5 token backfill interrupted");

    expect(readSchemaVersion(database)).toBe(1);
    expect(tableNames(database)).not.toContain("body_chunks");
    expect(tableNames(database)).not.toContain("history_summaries");
    expect(tableNames(database)).not.toContain("task_briefs");
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).not.toContain("request_token_count");
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).not.toContain("response_token_count");
    // The search table v3 would have dropped is still there, and the bodies are still inline.
    expect(tableNames(database)).toContain("record_search");
    expect(
      database
        .prepare("SELECT COUNT(*) FROM records WHERE response_body_json IS NOT NULL")
        .pluck()
        .get(),
    ).toBe(5);
    expect(recordsFingerprint(database)).toBe(recordsBefore);
    expect(tasksFingerprint(database)).toBe(tasksBefore);
    database.close();

    const reopened = openLogDatabase(logRoot);
    expect(readSchemaVersion(reopened)).toBe(1);
    expect(validateMigrationDatabase(logRoot).orphanCounts).toEqual({
      records: 0,
      response_links: 0,
      context_links: 0,
      record_search: 0,
    });
    reopened.close();
  });

  it("rolls the whole upgrade back when a stored body cannot be read at all", async () => {
    const logRoot = await copyFixture();
    const database = openLogDatabase(logRoot);

    runMigrations(database, [
      SCHEMA_V1_MIGRATION,
      SCHEMA_V2_MIGRATION,
      SCHEMA_V3_MIGRATION,
      SCHEMA_V4_MIGRATION,
    ]);
    expect(readSchemaVersion(database)).toBe(4);
    const recordsAfterV4 = recordsFingerprint(database);
    const chunksAfterV4 = database
      .prepare("SELECT COUNT(*) FROM record_body_chunks")
      .pluck()
      .get() as number;

    // One response chunk of one record is written with a codec nothing can inflate, so the v5
    // backfill reaches it, cannot read it, and the upgrade stops in the middle of the conversion.
    database
      .prepare(
        `UPDATE body_chunks
         SET codec = 'unsupported-codec-1'
         WHERE hash = (
           SELECT chunk_hash FROM record_body_chunks
           WHERE record_id = 'record-chat-1' AND body_kind = 'response'
         )`,
      )
      .run();
    expect(
      database
        .prepare("SELECT codec FROM body_chunks WHERE codec = 'unsupported-codec-1'")
        .pluck()
        .get(),
    ).toBe("unsupported-codec-1");

    expect(() => runMigrations(database, [...DATABASE_MIGRATIONS])).toThrow(
      "Unsupported body chunk codec",
    );

    // The upgrade stops at the version it had already reached: nothing from v5 onward is left, so
    // there is no half-built token column and no record with a partially written count.
    expect(readSchemaVersion(database)).toBe(4);
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).not.toContain("request_token_count");
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).not.toContain("response_token_count");
    expect(tableNames(database)).not.toContain("history_summaries");
    expect(tableNames(database)).not.toContain("task_briefs");
    expect(recordsFingerprint(database)).toBe(recordsAfterV4);
    expect(database.prepare("SELECT COUNT(*) FROM record_body_chunks").pluck().get()).toBe(
      chunksAfterV4,
    );
    expect(validateMigrationDatabase(logRoot).orphanCounts).toEqual({
      records: 0,
      response_links: 0,
      context_links: 0,
      record_search: 0,
    });
    database.close();
  });

  it("rolls the whole upgrade back when the v3 body conversion cannot run", async () => {
    const logRoot = await copyFixture();
    const database = openLogDatabase(logRoot);
    const recordsBefore = recordsFingerprint(database);

    // The old full-text table v3 copies from is gone, which is how a damaged old database reaches
    // the same place: the conversion stops inside the transaction.
    database.exec("DROP TABLE record_search");
    expect(() => runMigrations(database, [...DATABASE_MIGRATIONS])).toThrow(
      "no such table: record_search",
    );

    expect(readSchemaVersion(database)).toBe(1);
    expect(tableNames(database)).not.toContain("body_chunks");
    expect(tableNames(database)).not.toContain("record_search_map");
    expect(tableNames(database)).not.toContain("record_search_fts");
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).not.toContain("request_token_count");
    expect(recordsFingerprint(database)).toBe(recordsBefore);
    database.close();
  });
});

describe("[AI-13] money keeps its precision across the last migrations", () => {
  const PRICING_SNAPSHOT = JSON.stringify({
    algorithm_version: 1,
    input_per_million: "5",
    output_per_million: "30",
    cache_read_per_million: "0.5",
    cache_write_per_million: "6.25",
  });
  const BILLING_USAGE = JSON.stringify({
    inputUncachedTokens: 1500,
    outputTokens: 1000,
    cacheReadTokens: 1000,
    cacheWriteTokens: 500,
  });

  it("reads a nano-cent cost stored before v9 back as the same text after v13", async () => {
    const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-ai13-money-"));
    temporaryDirectories.push(logRoot);

    const database = openLogDatabase(logRoot);
    runMigrations(database, [
      SCHEMA_V1_MIGRATION,
      SCHEMA_V2_MIGRATION,
      SCHEMA_V3_MIGRATION,
      SCHEMA_V4_MIGRATION,
      SCHEMA_V5_MIGRATION,
      SCHEMA_V6_MIGRATION,
      SCHEMA_V7_MIGRATION,
      SCHEMA_V8_MIGRATION,
    ]);
    expect(readSchemaVersion(database)).toBe(8);
    database.exec(`
      INSERT INTO tasks(
        id, kind, started_at, last_seen_at, match_strategy_version, created_at, updated_at
      ) VALUES ('task-money', 'responses', '2026-07-18', '2026-07-18', 4,
                '2026-07-18', '2026-07-18');
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
        token_count, request_token_count, response_token_count, created_at, updated_at
      ) VALUES ('record-money', 'task-money', 1, 'request_finished', '2026-07-18',
                '2026-07-18', 'POST', '/v1/responses', '/v1/responses', 12, 7, 5,
                '2026-07-18', '2026-07-18');
    `);
    database
      .prepare(
        `UPDATE records
         SET pricing_status = 'priced', pricing_reason = NULL, billing_model = 'fixture-model',
             pricing_snapshot_json = ?, billing_usage_json = ?, cost_nano_cny = ?
         WHERE id = 'record-money'`,
      )
      .run(PRICING_SNAPSHOT, BILLING_USAGE, 41125000);
    database.close();

    const repository = new TrafficRepository(logRoot);
    const record = repository.getRecord("record-money");
    expect(record?.token_count).toBe(12);
    expect(record?.request_token_count).toBe(7);
    expect(record?.response_token_count).toBe(5);
    const cost = record?.pricing.cost_nano_cny;
    expect(typeof cost).toBe("string");
    expect(cost).toBe("41125000");

    const aggregate = repository.taskPricing("task-money");
    expect(aggregate?.cost_nano_cny).toBe("41125000");
    expect(aggregate?.groups.map(({ cost_nano_cny }) => cost_nano_cny)).toEqual(["41125000"]);
    repository.close();

    const upgraded = openLogDatabase(logRoot);
    expect(readSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare("SELECT CAST(cost_nano_cny AS TEXT) FROM records WHERE id = 'record-money'")
        .pluck()
        .get(),
    ).toBe("41125000");
    expect(
      (upgraded.pragma("table_info(records)") as { name: string; type: string }[]).find(
        ({ name }) => name === "cost_nano_cny",
      )?.type,
    ).toBe("INTEGER");
    upgraded.close();
  });
});
