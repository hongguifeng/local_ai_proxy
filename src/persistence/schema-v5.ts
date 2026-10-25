import { loadRecordBody } from "./body-storage.js";
import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V5_VERSION = 5;

export const SCHEMA_V5_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V5_VERSION,
  migrate(database) {
    const columns = database.pragma("table_info(records)") as { name: string }[];
    if (!columns.some(({ name }) => name === "request_token_count")) {
      database.exec("ALTER TABLE records ADD COLUMN request_token_count INTEGER");
    }
    if (!columns.some(({ name }) => name === "response_token_count")) {
      database.exec("ALTER TABLE records ADD COLUMN response_token_count INTEGER");
    }
    backfillTokenCounts(database);
  },
};

/** The two token counts v5 stores, each absent when the body carries no usage for it. */
export interface FrozenResponseTokenCounts {
  readonly request: number | undefined;
  readonly response: number | undefined;
}

/**
 * Request and output token counts as the v5 backfill reads them.
 *
 * [AI-13] The v5 backfill reinterprets stored response bodies, so its reading rules belong to the
 * history it produces, not to the protocol code that writes new records. `src/proxy/records.ts`
 * owns that job now and current protocol work rewrites it freely; keeping this copy inside the
 * migration is what stops such a rewrite from moving how an existing database upgrades. The copy
 * may drift from the live helper on purpose - `test-node/persistence/migration-freeze.test.ts`
 * pins it against the live helper's behaviour today, which is where a drift becomes visible.
 *
 * Only the no-endpoint-kind path is reproduced, because that is the only path v5 ever took:
 * `responseTokenCounts(payload)` was called without a kind, so the usage-normalisation branch was
 * never applied to stored data.
 */
export function frozenResponseTokenCounts(payload: unknown): FrozenResponseTokenCounts {
  const usage = frozenResponseUsage(payload);
  if (!isStoredObject(usage)) {
    return { request: undefined, response: undefined };
  }
  const input = storedTokenValue(usage, "input_tokens") ?? storedTokenValue(usage, "prompt_tokens");
  const cachedInputValues = ["cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => storedTokenValue(usage, key))
    .filter((value): value is number => value !== undefined);
  const cachedInput = cachedInputValues.reduce((sum, value) => sum + value, 0);
  return {
    request:
      input === undefined && cachedInputValues.length === 0
        ? undefined
        : (input ?? 0) + cachedInput,
    response:
      storedTokenValue(usage, "output_tokens") ?? storedTokenValue(usage, "completion_tokens"),
  };
}

function frozenResponseUsage(payload: unknown): unknown {
  if (!isStoredObject(payload)) {
    return undefined;
  }
  const streamSummary = payload["stream_summary"];
  if (isStoredObject(streamSummary) && isStoredTruthy(streamSummary["usage"])) {
    return streamSummary["usage"];
  }
  if (isStoredTruthy(payload["usage"])) {
    return payload["usage"];
  }
  const response = payload["response"];
  return isStoredObject(response) && isStoredTruthy(response["usage"])
    ? response["usage"]
    : undefined;
}

function storedTokenValue(
  usage: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** A JSON object as opposed to an array or a primitive. */
function isStoredObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Truthiness as the stored payloads were originally judged: an empty object, an empty array,
 * `0`, `""` and `false` all count as "no usage here", which is what keeps a body with
 * `"usage": {}` from being read as a zero-token request.
 */
function isStoredTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isStoredObject(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function backfillTokenCounts(database: Parameters<DatabaseMigration["migrate"]>[0]): void {
  const recordIds = database
    .prepare(
      `
        SELECT id
        FROM records
        WHERE token_count IS NOT NULL
          AND (request_token_count IS NULL OR response_token_count IS NULL)
      `,
    )
    .pluck()
    .all() as string[];
  const update = database.prepare(
    `
      UPDATE records
      SET request_token_count = ?, response_token_count = ?
      WHERE id = ?
    `,
  );
  for (const recordId of recordIds) {
    const responseBody = loadRecordBody(database, recordId, "response");
    if (responseBody === null) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      continue;
    }
    const counts = frozenResponseTokenCounts(payload);
    if (counts.request !== undefined || counts.response !== undefined) {
      update.run(counts.request ?? null, counts.response ?? null, recordId);
    }
  }
}
