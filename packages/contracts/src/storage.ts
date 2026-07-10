import { z } from "zod";

import { RecordDetailSchema } from "./admin.js";
import { ApiErrorSchema, EntityIdSchema, PaginationSchema } from "./common.js";

const WorkerRequestBaseSchema = z.strictObject({ requestId: EntityIdSchema });
const TransferablePayloadsSchema = z.strictObject({
  request: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer).optional(),
  response: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer).optional(),
});

export const StorageWorkerRequestSchema = z.discriminatedUnion("kind", [
  WorkerRequestBaseSchema.extend({ kind: z.literal("migrate") }),
  WorkerRequestBaseSchema.extend({
    kind: z.literal("writeTraffic"),
    record: RecordDetailSchema,
    transferredPayloads: TransferablePayloadsSchema.optional(),
  }),
  WorkerRequestBaseSchema.extend({
    kind: z.literal("listTasks"),
    query: z.string().max(1_000).default(""),
    pagination: PaginationSchema,
  }),
  WorkerRequestBaseSchema.extend({
    kind: z.literal("listRecords"),
    taskId: EntityIdSchema,
    pagination: PaginationSchema,
  }),
  WorkerRequestBaseSchema.extend({ kind: z.literal("getRecord"), recordId: EntityIdSchema }),
  WorkerRequestBaseSchema.extend({
    kind: z.literal("cleanup"),
    taskIds: z.array(EntityIdSchema).max(10_000).optional(),
    olderThanDays: z.number().int().min(0).max(3_650).optional(),
  }),
  WorkerRequestBaseSchema.extend({ kind: z.literal("drain") }),
  WorkerRequestBaseSchema.extend({ kind: z.literal("close") }),
]);

export const StorageWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ requestId: EntityIdSchema, ok: z.literal(true), result: z.json().optional() }),
  z.strictObject({ requestId: EntityIdSchema, ok: z.literal(false), error: ApiErrorSchema }),
]);

export type StorageWorkerRequest = z.infer<typeof StorageWorkerRequestSchema>;
export type StorageWorkerResponse = z.infer<typeof StorageWorkerResponseSchema>;
