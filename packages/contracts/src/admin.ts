import { z } from "zod";

import { EntityIdSchema, PaginationSchema, TimestampSchema } from "./common.js";
import { HeaderOverrideSchema, ModelMappingSchema, TargetUrlSchema, TimeoutConfigSchema } from "./config.js";

export const SecretStateSchema = z.strictObject({
  configured: z.boolean(),
  masked: z.string().max(64).optional(),
});

export const PublicTargetSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  url: TargetUrlSchema,
  apiKey: SecretStateSchema,
  headers: z.array(HeaderOverrideSchema),
  stripRequestFields: z.array(z.string()),
  injectRequestFields: z.record(z.string(), z.json()),
  timeouts: TimeoutConfigSchema,
  logRoot: z.string().nullable(),
  redactLogs: z.boolean(),
  modelMappings: z.array(ModelMappingSchema),
});

export const ProxyRuntimeStateSchema = z.enum(["stopped", "starting", "running", "stopping", "failed"]);

export const PublicProxySchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  listenHost: z.string(),
  listenPort: z.number().int(),
  accessLog: z.boolean(),
  targets: z.array(PublicTargetSchema),
  defaultTargetId: EntityIdSchema,
  runtime: z.strictObject({
    state: ProxyRuntimeStateSchema,
    actualListenPort: z.number().int().min(0).max(65_535).nullable(),
    errorCode: z.string().optional(),
  }),
});

export const ProxyListResponseSchema = z.strictObject({ proxies: z.array(PublicProxySchema) });

export const TaskSummarySchema = z.strictObject({
  id: EntityIdSchema,
  kind: z.enum(["responses", "chat", "messages", "completions", "other"]),
  endpoint: z.string(),
  model: z.string().nullable(),
  target: z.string().nullable(),
  startedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  requestCount: z.number().int().min(0),
  pending: z.boolean(),
});

export const RecordSummarySchema = z.strictObject({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  sequence: z.number().int().min(1),
  event: z.enum(["request_received", "request_finished", "aborted", "timed_out", "failed"]),
  timestamp: TimestampSchema,
  durationMs: z.number().min(0),
  method: z.string(),
  path: z.string(),
  status: z.number().int().min(100).max(599).nullable(),
  errorCode: z.string().nullable(),
  messageCount: z.number().int().min(0).nullable(),
  tokenCount: z.number().int().min(0).nullable(),
});

const CaptureMetadataSchema = z.strictObject({
  observedBytes: z.number().int().min(0),
  capturedBytes: z.number().int().min(0),
  truncated: z.boolean(),
});

export const CapturedPayloadSchema = z.discriminatedUnion("kind", [
  CaptureMetadataSchema.extend({ kind: z.literal("empty") }),
  CaptureMetadataSchema.extend({ kind: z.literal("json"), value: z.json() }),
  CaptureMetadataSchema.extend({ kind: z.literal("text"), text: z.string() }),
  CaptureMetadataSchema.extend({ kind: z.literal("binary"), base64: z.base64() }),
]);

export const RecordDetailSchema = RecordSummarySchema.extend({
  client: z.strictObject({ host: z.string(), port: z.number().int().min(0).max(65_535) }),
  proxy: z.strictObject({ id: EntityIdSchema, name: z.string() }),
  target: z.strictObject({ id: EntityIdSchema, name: z.string(), url: z.url() }),
  request: z.strictObject({ headers: z.record(z.string(), z.array(z.string())), body: CapturedPayloadSchema }),
  response: z
    .strictObject({ headers: z.record(z.string(), z.array(z.string())), body: CapturedPayloadSchema })
    .nullable(),
});

export const TaskListResponseSchema = PaginationSchema.extend({
  total: z.number().int().min(0),
  hasMore: z.boolean(),
  tasks: z.array(TaskSummarySchema),
});

export const RecordListResponseSchema = PaginationSchema.extend({
  total: z.number().int().min(0),
  hasMore: z.boolean(),
  records: z.array(RecordSummarySchema),
});

export type SecretState = z.infer<typeof SecretStateSchema>;
export type PublicTarget = z.infer<typeof PublicTargetSchema>;
export type PublicProxy = z.infer<typeof PublicProxySchema>;
export type ProxyListResponse = z.infer<typeof ProxyListResponseSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type RecordSummary = z.infer<typeof RecordSummarySchema>;
export type CapturedPayload = z.infer<typeof CapturedPayloadSchema>;
export type RecordDetail = z.infer<typeof RecordDetailSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type RecordListResponse = z.infer<typeof RecordListResponseSchema>;
