import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import Database from "better-sqlite3";

import {
  BODY_CHUNK_CODEC,
  TRAFFIC_DB_NAME,
  checkpointDatabase,
  connectLogDatabase,
  readSchemaVersion,
} from "../src/persistence/index.js";

export interface CompactTrafficResult {
  readonly source_bytes: number;
  readonly compact_bytes: number;
  readonly tasks: number;
  readonly records: number;
  readonly body_digest: string;
  readonly integrity_check: string;
  readonly foreign_key_violations: number;
}

export async function compactTrafficDatabase(
  sourceLogRoot: string,
  destinationLogRoot: string,
): Promise<CompactTrafficResult> {
  const sourcePath = path.join(sourceLogRoot, TRAFFIC_DB_NAME);
  const destinationPath = path.join(destinationLogRoot, TRAFFIC_DB_NAME);
  if (existsSync(destinationPath)) {
    throw new Error(`Destination database already exists: ${destinationPath}`);
  }
  mkdirSync(destinationLogRoot, { recursive: true });

  const source = new Database(sourcePath, { fileMustExist: true, readonly: true });
  try {
    await source.backup(destinationPath, { progress: () => 4_096 });
  } finally {
    source.close();
  }

  return compactTrafficDatabaseCopy(destinationLogRoot);
}

function compactTrafficDatabaseCopy(destinationLogRoot: string): CompactTrafficResult {
  const destinationPath = path.join(destinationLogRoot, TRAFFIC_DB_NAME);
  if (!existsSync(destinationPath)) {
    throw new Error(`Database copy does not exist: ${destinationPath}`);
  }
  const sourceBytes = statSync(destinationPath).size;

  const snapshot = new Database(destinationPath, { fileMustExist: true, readonly: true });
  let sourceDigest: string;
  let tasks: number;
  let records: number;
  try {
    sourceDigest = bodyDigest(snapshot);
    tasks = count(snapshot, "tasks");
    records = count(snapshot, "records");
  } finally {
    snapshot.close();
  }

  const compact = connectLogDatabase(destinationLogRoot);
  let compactDigest: string;
  let integrityCheck: string;
  let foreignKeyViolations: number;
  try {
    checkpointDatabase(compact, "TRUNCATE");
    compact.exec("VACUUM");
    checkpointDatabase(compact, "TRUNCATE");
    compactDigest = bodyDigest(compact);
    if (compactDigest !== sourceDigest) {
      throw new Error("Compacted body digest does not match the source snapshot");
    }
    if (count(compact, "tasks") !== tasks || count(compact, "records") !== records) {
      throw new Error("Compacted task or record count does not match the source snapshot");
    }
    integrityCheck = compact.pragma("integrity_check", { simple: true }) as string;
    foreignKeyViolations = (compact.pragma("foreign_key_check") as unknown[]).length;
  } finally {
    compact.close();
  }

  return {
    source_bytes: sourceBytes,
    compact_bytes: statSync(destinationPath).size,
    tasks,
    records,
    body_digest: compactDigest,
    integrity_check: integrityCheck,
    foreign_key_violations: foreignKeyViolations,
  };
}

function bodyDigest(database: Database.Database): string {
  if (readSchemaVersion(database) >= 3) return chunkedBodyDigest(database);
  const hash = createHash("sha256");
  const recordColumns = new Set(
    (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
  );
  const originalRequestColumn = recordColumns.has("original_request_body_json")
    ? "original_request_body_json"
    : "NULL AS original_request_body_json";
  const rows = database
    .prepare(
      `SELECT id, request_body_json, ${originalRequestColumn}, response_body_json
       FROM records ORDER BY id`,
    )
    .iterate() as Iterable<{
    id: string;
    request_body_json: string | null;
    original_request_body_json: string | null;
    response_body_json: string | null;
  }>;
  for (const row of rows) {
    digestValue(hash, row.id);
    for (const legacy of [
      row.request_body_json,
      row.original_request_body_json,
      row.response_body_json,
    ]) {
      digestValue(hash, legacy);
    }
  }
  return hash.digest("hex");
}

function chunkedBodyDigest(database: Database.Database): string {
  const rawChunks = new Map<string, Buffer>();
  const chunks = database
    .prepare("SELECT hash, codec, raw_size, data FROM body_chunks")
    .iterate() as Iterable<{ hash: Buffer; codec: string; raw_size: number; data: Buffer }>;
  for (const chunk of chunks) {
    if (chunk.codec !== BODY_CHUNK_CODEC) {
      throw new Error(`Unsupported body chunk codec: ${chunk.codec}`);
    }
    const raw = inflateRawSync(chunk.data);
    if (raw.length !== chunk.raw_size) throw new Error("Body chunk length mismatch");
    rawChunks.set(chunk.hash.toString("hex"), raw);
  }

  const references = new Map<string, Map<string, Buffer[]>>();
  const rows = database
    .prepare(
      `SELECT record_id, body_kind, chunk_hash
       FROM record_body_chunks
       ORDER BY record_id, body_kind, chunk_index`,
    )
    .iterate() as Iterable<{ record_id: string; body_kind: string; chunk_hash: Buffer }>;
  for (const row of rows) {
    let bodies = references.get(row.record_id);
    if (bodies === undefined) {
      bodies = new Map();
      references.set(row.record_id, bodies);
    }
    let parts = bodies.get(row.body_kind);
    if (parts === undefined) {
      parts = [];
      bodies.set(row.body_kind, parts);
    }
    const raw = rawChunks.get(row.chunk_hash.toString("hex"));
    if (raw === undefined) throw new Error("Record body references a missing chunk");
    parts.push(raw);
  }

  const hash = createHash("sha256");
  const recordIds = database
    .prepare("SELECT id FROM records ORDER BY id")
    .pluck()
    .iterate() as Iterable<string>;
  for (const recordId of recordIds) {
    digestValue(hash, recordId);
    const bodies = references.get(recordId);
    for (const kind of ["request", "original_request", "response"] as const) {
      digestParts(hash, bodies?.get(kind));
    }
  }
  return hash.digest("hex");
}

function digestParts(
  hash: ReturnType<typeof createHash>,
  parts: readonly Buffer[] | undefined,
): void {
  if (parts === undefined) {
    hash.update(Buffer.from([0]));
    return;
  }
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(parts.reduce((total, part) => total + part.length, 0)));
  hash.update(Buffer.from([1]));
  hash.update(length);
  for (const part of parts) hash.update(part);
}

function digestValue(hash: ReturnType<typeof createHash>, value: string | null): void {
  if (value === null) {
    hash.update(Buffer.from([0]));
    return;
  }
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(Buffer.from([1]));
  hash.update(length);
  hash.update(bytes);
}

function count(database: Database.Database, table: string): number {
  return database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceLogRoot = process.argv[2];
  const destinationLogRoot = process.argv[3];
  if (sourceLogRoot === undefined || destinationLogRoot === undefined) {
    throw new Error("Usage: compact_traffic_database <source-log-root> <destination-log-root>");
  }
  process.stdout.write(
    `${JSON.stringify(await compactTrafficDatabase(sourceLogRoot, destinationLogRoot), null, 2)}\n`,
  );
}
