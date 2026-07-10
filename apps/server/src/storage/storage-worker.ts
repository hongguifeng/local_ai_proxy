import { parentPort, threadId, workerData } from "node:worker_threads";

import {
  StorageWorkerRequestSchema,
  StorageWorkerResponseSchema,
  type RecordDetail,
  type StorageWorkerRequest,
} from "@llm-proxy/contracts";

import { openStorageDatabase, readSchemaVersion } from "./migration.js";
import { StorageRepository } from "./repository.js";
import { TrafficRecordWriter } from "./traffic-record-writer.js";

if (!parentPort) throw new Error("Storage worker requires a parent port");
const port: NonNullable<typeof parentPort> = parentPort;

let database: ReturnType<typeof openStorageDatabase> | null = null;

try {
  const data = workerData as { databasePath?: unknown };
  if (typeof data.databasePath !== "string") throw new TypeError("Missing database path");
  database = openStorageDatabase(data.databasePath);
  const repository = new StorageRepository(database);
  const trafficWriter = new TrafficRecordWriter(repository);
  port.postMessage({ kind: "ready" });
  port.on("message", (input: unknown) => {
    if (isForcedExit(input)) {
      requireDatabase().close();
      database = null;
      process.exitCode = 1;
      port.close();
      return;
    }
    const parsed = StorageWorkerRequestSchema.safeParse(input);
    if (!parsed.success) {
      const requestId = requestIdFrom(input);
      if (requestId) postError(requestId, "INVALID_WORKER_REQUEST", "Storage worker request is invalid");
      return;
    }
    handleRequest(parsed.data, repository, trafficWriter);
  });
} catch {
  port.postMessage({
    kind: "fatal",
    error: { code: "STORAGE_START_FAILED", message: "Storage worker failed to start" },
  });
  port.close();
}

function handleRequest(
  request: StorageWorkerRequest,
  repository: StorageRepository,
  trafficWriter: TrafficRecordWriter,
): void {
  try {
    let result: unknown;
    if (request.kind === "migrate") result = { schemaVersion: readSchemaVersion(requireDatabase()), threadId };
    else if (request.kind === "listTasks")
      result = repository.listTasks(request.query, request.pagination.limit, request.pagination.offset);
    else if (request.kind === "listRecords")
      result = repository.listRecords(request.taskId, request.pagination.limit, request.pagination.offset);
    else if (request.kind === "getRecord") result = repository.getRecord(request.recordId);
    else if (request.kind === "writeTraffic") {
      const record = hydrateTransferredPayloads(request.record, request.transferredPayloads);
      const assignment = trafficWriter.write(record);
      result = { written: true, taskId: assignment.task.id, sequence: assignment.sequence };
    } else if (request.kind === "cleanup") {
      result = { deleted: repository.deleteTasks(request.taskIds ?? []) };
    } else if (request.kind === "drain") result = { drained: true };
    else {
      postResponse({ requestId: request.requestId, ok: true, result: { closed: true } });
      requireDatabase().close();
      database = null;
      port.close();
      return;
    }

    postResponse({ requestId: request.requestId, ok: true, ...(result === undefined ? {} : { result }) });
  } catch {
    postError(request.requestId, "STORAGE_OPERATION_FAILED", "Storage operation failed");
  }
}

function hydrateTransferredPayloads(
  record: RecordDetail,
  transferred: Readonly<{ request?: ArrayBuffer | undefined; response?: ArrayBuffer | undefined }> | undefined,
): RecordDetail {
  if (!transferred) return record;
  const request = transferred.request ? hydrateBody(record.request.body, transferred.request) : record.request.body;
  const responseBody = transferred.response
    ? hydrateBody(record.response?.body, transferred.response)
    : record.response?.body;
  return {
    ...record,
    request: { ...record.request, body: request },
    response: record.response ? { ...record.response, body: responseBody ?? record.response.body } : null,
  };
}

function hydrateBody(
  body: RecordDetail["request"]["body"] | undefined,
  data: ArrayBuffer,
): RecordDetail["request"]["body"] {
  if (body?.kind !== "binary" || body.capturedBytes !== data.byteLength) {
    throw new TypeError("Transferred payload metadata does not match");
  }
  return { ...body, base64: Buffer.from(data).toString("base64") };
}

function requireDatabase(): NonNullable<typeof database> {
  if (!database) throw new Error("Storage database is closed");
  return database;
}

function postError(requestId: string, code: string, message: string): void {
  postResponse({ requestId, ok: false, error: { code, message } });
}

function postResponse(response: unknown): void {
  port.postMessage(StorageWorkerResponseSchema.parse(response));
}

function requestIdFrom(input: unknown): string | null {
  if (!input || typeof input !== "object" || !("requestId" in input)) return null;
  return typeof input.requestId === "string" ? input.requestId : null;
}

function isForcedExit(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && "kind" in input && input.kind === "__force_exit__");
}
