import path from "node:path";

export const TRAFFIC_DB_NAME = "traffic.db";

export function logDatabasePath(logRoot: string | null | undefined): string | undefined {
  return logRoot === null || logRoot === undefined
    ? undefined
    : path.join(logRoot, TRAFFIC_DB_NAME);
}
