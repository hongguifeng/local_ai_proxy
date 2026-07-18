import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export interface MigrationValidation {
  readonly counts: Readonly<Record<string, number>>;
  readonly orphanCounts: Readonly<Record<string, number>>;
  readonly sampleRecord: Readonly<Record<string, unknown>> | undefined;
  readonly sampleTask: Readonly<Record<string, unknown>> | undefined;
}

export function validateMigrationDatabase(logRoot: string): MigrationValidation {
  const database = new Database(path.join(logRoot, "traffic.db"), { readonly: true });
  try {
    const counts = Object.fromEntries(
      ["tasks", "records", "response_links", "context_links", "record_search"].map((table) => [
        table,
        count(database, `SELECT COUNT(*) AS count FROM ${table}`),
      ]),
    );
    const orphanCounts = {
      records: count(
        database,
        "SELECT COUNT(*) AS count FROM records r LEFT JOIN tasks t ON t.id = r.task_id WHERE t.id IS NULL",
      ),
      response_links: count(
        database,
        "SELECT COUNT(*) AS count FROM response_links l LEFT JOIN tasks t ON t.id = l.task_id WHERE t.id IS NULL",
      ),
      context_links: count(
        database,
        "SELECT COUNT(*) AS count FROM context_links l LEFT JOIN tasks t ON t.id = l.task_id WHERE t.id IS NULL",
      ),
      record_search: count(
        database,
        "SELECT COUNT(*) AS count FROM record_search s LEFT JOIN records r ON r.id = s.record_id WHERE r.id IS NULL",
      ),
    };
    const sampleTask = database
      .prepare("SELECT id, kind, model, request_count FROM tasks ORDER BY id LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    const sampleRecord = database
      .prepare("SELECT id, task_id, method, path, status FROM records ORDER BY id LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return { counts, orphanCounts, sampleTask, sampleRecord };
  } finally {
    database.close();
  }
}

function count(database: Database.Database, sql: string): number {
  const row = database.prepare(sql).get() as { count: number };
  return row.count;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logRoot = process.argv[2];
  if (logRoot === undefined) throw new Error("Usage: validate_migration <log-root>");
  process.stdout.write(`${JSON.stringify(validateMigrationDatabase(logRoot), null, 2)}\n`);
}
