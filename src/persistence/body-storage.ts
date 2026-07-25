import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import type Database from "better-sqlite3";

export const BODY_CHUNK_BYTES = 64 * 1024;
export const BODY_CHUNK_CODEC = "deflate-raw-1";

export const RECORD_BODY_KINDS = ["request", "original_request", "response"] as const;
export type RecordBodyKind = (typeof RECORD_BODY_KINDS)[number];

interface StoredChunk {
  readonly data: Buffer;
  readonly raw_size: number;
  readonly codec: string;
}

export function replaceRecordBody(
  database: Database.Database,
  recordId: string,
  kind: RecordBodyKind,
  text: string | null,
): void {
  database
    .prepare("DELETE FROM record_body_chunks WHERE record_id = ? AND body_kind = ?")
    .run(recordId, kind);

  if (text !== null) {
    const chunkMetadata = database.prepare(
      "SELECT codec, raw_size FROM body_chunks WHERE hash = ?",
    );
    const incrementChunk = database.prepare(
      "UPDATE body_chunks SET reference_count = reference_count + 1 WHERE hash = ?",
    );
    const insertChunk = database.prepare(`
      INSERT INTO body_chunks(hash, codec, raw_size, data, reference_count)
      VALUES (?, ?, ?, ?, 1)
    `);
    const insertReference = database.prepare(`
      INSERT INTO record_body_chunks(record_id, body_kind, chunk_index, chunk_hash)
      VALUES (?, ?, ?, ?)
    `);
    const body = Buffer.from(text, "utf8");
    let chunkIndex = 0;
    for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) {
      const raw = body.subarray(offset, offset + BODY_CHUNK_BYTES);
      const hash = createHash("sha256").update(raw).digest();
      const existing = chunkMetadata.get(hash) as { codec: string; raw_size: number } | undefined;
      if (existing === undefined) {
        insertChunk.run(hash, BODY_CHUNK_CODEC, raw.length, deflateRawSync(raw, { level: 1 }));
      } else {
        if (existing.codec !== BODY_CHUNK_CODEC || existing.raw_size !== raw.length) {
          throw new Error("Body chunk hash collision or incompatible stored chunk");
        }
        incrementChunk.run(hash);
      }
      insertReference.run(recordId, kind, chunkIndex, hash);
      chunkIndex += 1;
    }
  }
}

export function loadRecordBody(
  database: Database.Database,
  recordId: string,
  kind: RecordBodyKind,
): string | null {
  const rows = database
    .prepare(
      `
        SELECT chunks.codec, chunks.raw_size, chunks.data
        FROM record_body_chunks AS references_
        JOIN body_chunks AS chunks ON chunks.hash = references_.chunk_hash
        WHERE references_.record_id = ? AND references_.body_kind = ?
        ORDER BY references_.chunk_index
      `,
    )
    .all(recordId, kind) as StoredChunk[];
  if (rows.length === 0) return null;
  const parts = rows.map((row) => {
    if (row.codec !== BODY_CHUNK_CODEC) {
      throw new Error(`Unsupported body chunk codec: ${row.codec}`);
    }
    const raw = inflateRawSync(row.data);
    if (raw.length !== row.raw_size) {
      throw new Error(`Body chunk length mismatch for record ${recordId}`);
    }
    return raw;
  });
  return Buffer.concat(parts).toString("utf8");
}

export function migrateLegacyRecordBodies(database: Database.Database): void {
  const ids = database.prepare("SELECT id FROM records ORDER BY rowid").pluck().all() as string[];
  const load = database.prepare(`
    SELECT request_body_json, original_request_body_json, response_body_json
    FROM records
    WHERE id = ?
  `);
  for (const id of ids) {
    const row = load.get(id) as
      | {
          request_body_json: string | null;
          original_request_body_json: string | null;
          response_body_json: string | null;
        }
      | undefined;
    if (row === undefined) continue;
    replaceRecordBody(database, id, "request", row.request_body_json);
    replaceRecordBody(database, id, "original_request", row.original_request_body_json);
    replaceRecordBody(database, id, "response", row.response_body_json);
  }
  database.exec(`
    UPDATE records
    SET request_body_json = NULL,
        original_request_body_json = NULL,
        response_body_json = NULL
  `);
}
