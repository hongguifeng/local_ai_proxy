import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export const TRAFFIC_DB_NAME = "traffic.db";

export function logDatabasePath(logRoot: string | null | undefined): string | undefined {
  return logRoot === null || logRoot === undefined
    ? undefined
    : path.join(logRoot, TRAFFIC_DB_NAME);
}

export function openLogDatabase(logRoot: string): Database.Database {
  mkdirSync(logRoot, { recursive: true });
  return new Database(path.join(logRoot, TRAFFIC_DB_NAME));
}
