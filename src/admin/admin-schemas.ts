import { z } from "zod";

/**
 * Every wire shape the admin API answers or accepts is declared here, once, as a Zod
 * schema. The TypeScript types in `admin-contracts.ts` and the schemas Fastify compiles
 * are both read off these declarations, so a renamed or forgotten field cannot change one
 * side without the other: the contract type and the serializer are the same object seen
 * twice. The conversion rules, the open/closed decisions and the two constraints that
 * have to be attached as metadata are written up in
 * `docs/refactoring/admin-api-contract.md`.
 *
 * A payload is closed when this project writes every key of it, and open where the
 * content is something this project does not own — the summary model's own JSON, a stored
 * pricing block, a request body, a proxy pair. Closure is what makes fast-json-stringify
 * drop an undeclared key, which is how field drift turns into a failing contract test
 * instead of `undefined` in the browser.
 */

/** A JSON Schema object as Fastify's compilers accept it. */
export type AdminJsonSchema = Readonly<Record<string, unknown>>;

/**
 * The DTOs are declared with Zod, whose inferred shape is mutable, while every service in
 * this project answers with `readonly` fields and `readonly` arrays. Wrapping the inferred
 * type in `DeepReadonly` is what lets a service model be assigned to the contract type: a
 * `readonly T[]` is not assignable to a `T[]`.
 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The contract type of a declared DTO: the serialized shape, read-only all the way down. */
export type AdminDto<T extends z.ZodType> = DeepReadonly<z.output<T>>;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes every `propertyNames` that only says "keys are strings". The check is a no-op on
 * JSON — every key of an object is already a string — while fast-json-stringify's strict
 * validator writes two warnings to stderr for each one it meets, nested ones included. That
 * is why the walk goes all the way down instead of stopping at the root.
 */
function dropStringKeyConstraint(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropStringKeyConstraint(item);
    return;
  }
  if (!isSchemaObject(node)) return;
  const propertyNames = node["propertyNames"];
  if (
    isSchemaObject(propertyNames) &&
    Object.keys(propertyNames).length === 1 &&
    propertyNames["type"] === "string"
  ) {
    delete node["propertyNames"];
  }
  for (const child of Object.values(node)) dropStringKeyConstraint(child);
}

/**
 * Collapses `anyOf: [<a schema with its own type>, { type: "null" }]` into one schema whose
 * `type` is a list. Zod's `.nullable()` produces the union, and fast-json-stringify validates
 * an `anyOf` value with its ajv validator, which turns a key the schema does not declare into
 * a serialization error instead of dropping it. The type list says the same thing and stays on
 * the serializer's ordinary path: a closed shape still drops undeclared keys, an open one
 * still keeps them, and `null` is still printed as `null`.
 */
function collapseNullableUnion(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) collapseNullableUnion(item);
    return;
  }
  if (!isSchemaObject(node)) return;
  const branches = node["anyOf"];
  if (Array.isArray(branches) && branches.length === 2) {
    let nullBranch: Record<string, unknown> | undefined;
    let valueBranch: Record<string, unknown> | undefined;
    for (const branch of branches) {
      if (!isSchemaObject(branch)) continue;
      if (branch["type"] === "null") nullBranch = branch;
      else if (typeof branch["type"] === "string") valueBranch = branch;
    }
    if (nullBranch !== undefined && valueBranch !== undefined) {
      const merged: Record<string, unknown> = { ...node, ...valueBranch };
      delete merged["anyOf"];
      merged["type"] = [valueBranch["type"], "null"];
      delete node["anyOf"];
      Object.assign(node, merged);
    }
  }
  for (const child of Object.values(node)) collapseNullableUnion(child);
}

/**
 * Turns a DTO declaration into the object Fastify compiles. Three parts of Zod's JSON Schema
 * output cannot be handed over as they are:
 *
 * - `$schema`: Fastify's validator is a draft-07 compiler and refuses the reference with
 *   `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"` as soon as a
 *   request schema declares it. The draft-07 keywords Zod emits are all understood, so the
 *   declaration itself needs no translation.
 * - `propertyNames` when it only says "keys are strings", for the reason above.
 * - `.nullable()`'s `anyOf`, for the reason above.
 *
 * `additionalProperties: {}` is left alone: it is Zod's way of saying "any other key is
 * allowed", and both compilers act on it — an undeclared key survives validation and
 * serialization. That is how openness is expressed here.
 */
export function toAdminJsonSchema(schema: z.ZodType): AdminJsonSchema {
  const schemaObject: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete schemaObject["$schema"];
  dropStringKeyConstraint(schemaObject);
  collapseNullableUnion(schemaObject);
  return schemaObject;
}

const openRecord = z.record(z.string(), z.unknown());
const pathId = z.object({ id: z.string().min(1) });
const targetUrl = z
  .string()
  .min(1)
  .max(8_192)
  .regex(/^https?:\/\//);
const apiKey = z.string().max(65_536);

// -------------------------------------------------------------------------------- 1. errors

/**
 * The one shape every error answer takes: `{ error: { code, message } }`. The wire shape is
 * consumed by the browser and must not change, so the DTO is closed — an accidental extra
 * field cannot ride along with an error. The field paths of a rejected configuration are
 * deliberately not declared here: they are answered only by the server's error handler, and
 * attaching this schema to an error status would delete them because
 * `fast-json-stringify` prints only the properties a schema declares. `AdminConfigFieldIssues`
 * in `admin-contracts.ts` carries them, and the reason is written up in
 * `docs/refactoring/admin-api-contract.md`.
 */
const adminErrorDto = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type AdminErrorDto = AdminDto<typeof adminErrorDto>;
export const ADMIN_ERROR_DTO_SCHEMA = toAdminJsonSchema(adminErrorDto);

/**
 * The response map of a JSON route: its success answer, and nothing else. Error statuses are
 * intentionally not attached, for the reason above: every error answer is produced by
 * `adminError()` or the server's error handler, both typed by this declaration, so a rename
 * stops the build instead of needing a serializer to catch it.
 */
export function adminResponseSchemas(ok: AdminJsonSchema): Record<number, AdminJsonSchema> {
  return { 200: ok };
}

// -------------------------------------------------------------------------------- 2. health

const healthSnapshotDto = z.object({
  applicationState: z.string(),
  status: z.enum(["degraded", "ok", "starting", "stopping"]),
  version: z.string(),
});

export type HealthStatus = z.output<typeof healthSnapshotDto>["status"];
export type HealthSnapshot = AdminDto<typeof healthSnapshotDto>;
export const HEALTH_SNAPSHOT_SCHEMA = toAdminJsonSchema(healthSnapshotDto);

// -------------------------------------------------------------------------------- 3. pairs

/**
 * A proxy pair as the configuration module owns it. The object is answered and accepted
 * with every key it carries: the browser reads keys this file does not list, and the same
 * object is posted back when a pair is saved. Only the wrapper — the `pairs`/`pair` key — is
 * declared here; the pair itself stays open on purpose.
 */
const pairPayload = z.looseObject({});

const pairsResponseDto = z.object({ pairs: z.array(pairPayload) });
const pairResponseDto = z.object({ pair: pairPayload });
const replacePairsRequestDto = z.object({ pairs: z.array(pairPayload) });
/**
 * The enabled toggle is open like the pair it belongs to: the console posts pair objects that
 * carry keys this file does not declare, and a closed body would delete them before the
 * handler ran. The handler reads `enabled` and nothing else.
 */
const setPairEnabledRequestDto = z.looseObject({ enabled: z.boolean() });

export const PAIRS_RESPONSE_SCHEMA = toAdminJsonSchema(pairsResponseDto);
export const PAIR_RESPONSE_SCHEMA = toAdminJsonSchema(pairResponseDto);
export const REPLACE_PAIRS_REQUEST_SCHEMA = toAdminJsonSchema(replacePairsRequestDto);
export const SET_PAIR_ENABLED_REQUEST_SCHEMA = toAdminJsonSchema(setPairEnabledRequestDto);

// -------------------------------------------------------------------------------- 4. target probes

/**
 * The three target probes. Their request and answer types stay in `src/proxy`, which is the
 * code that produces them; this file declares only the wire structure they travel in, so the
 * route can validate and serialize without inventing a second shape.
 */
const targetCheckRequestDto = z.object({
  targetUrl,
  model: z.string().min(1).max(512),
  apiType: z.enum(["chat", "responses", "anthropic"]).optional(),
  apiKey: apiKey.optional(),
});
const targetCheckResponseDto = z.object({
  ok: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().min(0),
  error: z.string().max(8_192).optional(),
  detail: z.string().max(8_192).optional(),
});

const targetMetricsRequestDto = z.object({ targetUrl, apiKey: apiKey.optional() });
const targetMetricsResponseDto = z.object({
  ok: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().min(0),
  text: z.string().max(1_048_576).optional(),
  truncated: z.boolean().optional(),
  error: z.string().max(8_192).optional(),
});

const targetModelsRequestDto = targetMetricsRequestDto;
const targetModelsResponseDto = z.object({
  ok: z.boolean(),
  models: z.array(z.string().min(1)).max(1_000),
  durationMs: z.number().min(0),
  truncated: z.boolean().optional(),
  error: z.string().max(8_192).optional(),
});

export const TARGET_CHECK_REQUEST_SCHEMA = toAdminJsonSchema(targetCheckRequestDto);
export const TARGET_CHECK_RESPONSE_SCHEMA = toAdminJsonSchema(targetCheckResponseDto);
export const TARGET_METRICS_REQUEST_SCHEMA = toAdminJsonSchema(targetMetricsRequestDto);
export const TARGET_METRICS_RESPONSE_SCHEMA = toAdminJsonSchema(targetMetricsResponseDto);
export const TARGET_MODELS_REQUEST_SCHEMA = toAdminJsonSchema(targetModelsRequestDto);
export const TARGET_MODELS_RESPONSE_SCHEMA = toAdminJsonSchema(targetModelsResponseDto);

export type AdminTargetCheckRequestInput = z.input<typeof targetCheckRequestDto>;
export type AdminTargetProbeRequestInput = z.input<typeof targetMetricsRequestDto>;
export type AdminModelPricesImportRequestInput = z.input<typeof modelPricesImportRequestDto>;
export type AdminSetPairEnabledBody = z.input<typeof setPairEnabledRequestDto>;

// ------------------------------------------------------------- 5. model price catalog import

const priceRate = z
  .string()
  .max(30)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);

const modelPricesImportRequestDto = z.object({
  targetUrl,
  targetApiKey: apiKey.optional(),
  priceRate: priceRate.optional(),
});

const pricingBucketDto = z.object({
  tokens: z.string(),
  amount: z.string(),
});
const pricingPriceDto = z.object({
  input_per_million: z.string(),
  output_per_million: z.string(),
  cache_read_per_million: z.string(),
  cache_write_per_million: z.string(),
});

const modelPricesImportResponseDto = z.object({
  models: z.array(z.string().min(1)),
  rules: z.array(
    z.object({
      model_pattern: z.string().min(1),
      input_per_million: z.string(),
      output_per_million: z.string(),
      cache_read_per_million: z.string(),
      cache_write_per_million: z.string(),
    }),
  ),
  unmatched: z.array(z.string().min(1)),
  catalog: z.object({
    source: z.string().min(1),
    fetchedAt: z.number().int().min(0),
  }),
});

export const MODEL_PRICES_IMPORT_REQUEST_SCHEMA = toAdminJsonSchema(modelPricesImportRequestDto);
export const MODEL_PRICES_IMPORT_RESPONSE_SCHEMA = toAdminJsonSchema(modelPricesImportResponseDto);

// --------------------------------------------------------------- 6. load balancer read-out

const loadBalancerMetricsDto = z.object({
  kvUsage: z.number().nullable().optional(),
  // Null means the engine never answered that number; a zero it really reported stays zero.
  running: z.number().int().min(0).nullable(),
  sampledAt: z.number().int().min(0),
  source: z.string().max(256),
  waiting: z.number().int().min(0).nullable(),
});

const loadBalancerNodeDto = z.object({
  bindings: z.number().int().min(0),
  canonicalKey: z.string().max(8_192),
  cooldownRemainingMs: z.number().int().min(0),
  enabled: z.boolean(),
  failures: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  inRotation: z.boolean(),
  lastDispatchedAt: z.number().int().nullable(),
  metrics: loadBalancerMetricsDto.nullable(),
  stale: z.boolean(),
  targetId: z.string().max(512),
});

const loadBalancerGroupDto = z.object({
  bindings: z.number().int().min(0),
  enabled: z.boolean(),
  failoverEnabled: z.boolean(),
  id: z.string().max(512),
  metricsEnabled: z.boolean(),
  modelPattern: z.string().max(512),
  name: z.string().max(512),
  nodeTargetIds: z.array(z.string().max(512)).max(256),
  nodes: z.array(loadBalancerNodeDto).max(256),
  strategy: z.string().max(64),
});

const loadBalancerPairDto = z.object({
  enabled: z.boolean(),
  groups: z.array(loadBalancerGroupDto).max(256),
  id: z.string().max(512),
  name: z.string().max(512),
  running: z.boolean(),
});

const loadBalancerStatusDto = z.object({
  now: z.number().int().min(0),
  pairs: z.array(loadBalancerPairDto).max(256),
});

export const LOAD_BALANCER_STATUS_RESPONSE_SCHEMA = toAdminJsonSchema(loadBalancerStatusDto);

// ------------------------------------------- 6b. [TRI-05] binding list and history association

/**
 * The binding-list read and its answer. Everything here is closed: this project writes every
 * key of both sides, so a field that drifts is dropped by the serializer and shows up as a
 * failing contract test instead of `undefined` in the browser. The page caps live on this
 * schema, which is what makes a client's `limit` a server-side limit rather than a suggestion.
 *
 * Nothing in this section carries an exact key, a request or response body, a user message,
 * a user-message hash, an API key or a session id; the boundary evidence the history query
 * needs stays inside the service.
 */

/** How much of the load an engine answered, and whether its answer still says "now". */
const metricCompletenessDto = z.enum(["complete", "partial", "no_load_numbers"]);
const sampleFreshnessDto = z.enum(["fresh", "stale", "never_sampled"]);

const loadBalancerNodeMetricsDto = z.object({
  awake: z.boolean().nullable(),
  completeness: metricCompletenessDto,
  freshness: sampleFreshnessDto,
  // A share the engine reported is printed as it stands; no bound is declared because the
  // exposition is not ours to constrain and a rejected number would answer 500.
  kvUsage: z.number().nullable(),
  running: z.number().int().min(0).nullable(),
  sampleSequence: z.number().int().min(0).nullable(),
  sampledAt: z.number().int().min(0).nullable(),
  source: z.string().max(256).nullable(),
  usableForLoadJudgement: z.boolean(),
  waiting: z.number().int().min(0).nullable(),
});

const loadBalancerBindingNodeDto = z.object({
  bindings: z.number().int().min(0),
  canonicalKey: z.string().max(8_192),
  cooldownRemainingMs: z.number().int().min(0),
  enabled: z.boolean(),
  failures: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  inRotation: z.boolean(),
  lastDispatchedAt: z.number().int().nullable(),
  metrics: loadBalancerNodeMetricsDto,
  targetId: z.string().max(512),
});

/** Where the latest cost signal came from, in the ledger's own vocabulary. */
const bindingCostSourceDto = z.enum(["normalized_usage", "request_bytes", "none"]);

const loadBalancerBindingContextDto = z.object({
  cacheReadTokens: z.number().int().min(0).nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  observedAt: z.number().int().min(0).nullable(),
  requestBytes: z.number().int().min(0).nullable(),
  source: bindingCostSourceDto,
});

const endpointKindDto = z.enum(["responses", "messages", "chat", "completions", "other"]);

/** The three states the activity ledger can support; none of them says a task finished. */
const bindingActivityStateDto = z.enum(["in_flight", "idle", "unknown"]);

const movableReasonDto = z.enum(["migration_unavailable", "in_flight"]);

const loadBalancerBindingMovabilityDto = z.object({
  ok: z.boolean(),
  reasons: z.array(movableReasonDto).max(2),
});

const historyAssociationLevelDto = z.enum(["high", "candidate"]);
const historyAssociationConfidenceDto = z.enum(["high", "candidate", "none"]);
const historyCoverageStateDto = z.enum([
  "no_log_configured",
  "no_traffic_database",
  "available",
  "failed",
]);

/** Why an association ended up the way it did, spelled exactly as the history reader spells it. */
const historyAssociationReasonDto = z.enum([
  "exact_key_links",
  "several_linked_tasks",
  "key_without_link",
  "key_without_task",
  "link_boundary_mismatch",
  "key_limit_exceeded",
  "boundary_candidates",
  "candidate_scan_truncated",
  "task_list_truncated",
  "no_log_configured",
  "no_traffic_database",
  "history_query_failed",
  "log_write_may_be_pending",
]);

const historyFailureDto = z.object({
  code: z.string().max(128).nullable(),
  errorName: z.string().max(256),
  message: z.string().max(512),
  phase: z.enum(["open", "read"]),
});

const loadBalancerHistoryCoverageDto = z.object({
  candidateRowsRead: z.number().int().min(0),
  candidateScanLimit: z.number().int().min(0),
  exactKeysExamined: z.number().int().min(0),
  exactKeysLinked: z.number().int().min(0),
  exactKeysOmitted: z.number().int().min(0),
  exactKeysRequested: z.number().int().min(0),
  exactKeysWithoutLink: z.number().int().min(0),
  exactLinkRowsRead: z.number().int().min(0),
  failure: historyFailureDto.nullable(),
  historyRowsRead: z.number().int().min(0),
  historyTruncated: z.boolean(),
  latestStoredRecordAt: z.string().max(64).nullable(),
  linkedTasksRead: z.number().int().min(0),
  logWriteMayBePending: z.boolean(),
  returnedTaskLimit: z.number().int().min(0),
  state: historyCoverageStateDto,
});

const loadBalancerAssociatedTaskDto = z.object({
  endpoint: z.string().max(512).nullable(),
  exactKeyMatches: z.number().int().min(0),
  historyTargetNode: z.enum(["same", "different", "unknown"]),
  kind: z.string().max(64),
  lastResponseAt: z.string().max(64).nullable(),
  lastSeenAt: z.string().max(64),
  level: historyAssociationLevelDto,
  model: z.string().max(512).nullable(),
  pendingRequestOnly: z.boolean(),
  requestCount: z.number().int().min(0),
  taskId: z.string().max(512),
});

const loadBalancerBindingAssociationsDto = z.object({
  ambiguous: z.boolean(),
  confidence: historyAssociationConfidenceDto,
  coverage: loadBalancerHistoryCoverageDto,
  reasons: z.array(historyAssociationReasonDto).max(13),
  taskIds: z.array(z.string().max(512)).max(200),
  tasks: z.array(loadBalancerAssociatedTaskDto).max(200),
});

const loadBalancerBindingItemDto = z.object({
  activity: bindingActivityStateDto,
  associations: loadBalancerBindingAssociationsDto,
  bindingId: z.number().int().min(0),
  context: loadBalancerBindingContextDto,
  endpoint: z.string().max(512),
  endpointKind: endpointKindDto,
  incarnation: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  lastBoundAt: z.number().int().min(0),
  lastRequestStartedAt: z.number().int().nullable(),
  lastResponseEndedAt: z.number().int().nullable(),
  lastSeenAt: z.number().int().min(0),
  model: z.string().max(512).nullable(),
  movable: loadBalancerBindingMovabilityDto,
  recentRequestStarts: z.array(z.number().int().min(0)).max(16),
  requestCount: z.number().int().min(0),
  routingRevision: z.number().int().min(0),
  targetId: z.string().max(512),
});

const loadBalancerTasksResponseDto = z.object({
  groupRevision: z.number().int().min(0).nullable(),
  groupId: z.string().max(512),
  hasMore: z.boolean(),
  items: z.array(loadBalancerBindingItemDto).max(200),
  limit: z.number().int().min(1).max(200),
  // The migration service (TRI-07) does not exist yet, so no move can be performed; this is
  // the capability answer and `movable.reasons` is the per-binding one.
  migration: z.enum(["unavailable"]),
  nextOffset: z.number().int().min(0),
  nodes: z.array(loadBalancerBindingNodeDto).max(256),
  now: z.number().int().min(0),
  offset: z.number().int().min(0),
  pairId: z.string().max(512),
  runtimeEpoch: z.string().max(512).nullable(),
  targetFilter: z.string().max(512).nullable(),
  totalBindings: z.number().int().min(0),
});

const loadBalancerTasksQueryDto = z.object({
  pairId: z.string().min(1).max(512),
  groupId: z.string().min(1).max(512),
  targetId: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const LOAD_BALANCER_TASKS_RESPONSE_SCHEMA = toAdminJsonSchema(loadBalancerTasksResponseDto);
export const LOAD_BALANCER_TASKS_QUERY_SCHEMA = toAdminJsonSchema(loadBalancerTasksQueryDto);

/**
 * What the browser may send to the binding list, before the schema's defaults are applied -
 * the same convention the log query types use.
 */
export type AdminLoadBalancerTasksQuery = z.input<typeof loadBalancerTasksQueryDto>;
export type AdminLoadBalancerTasksResponse = AdminDto<typeof loadBalancerTasksResponseDto>;

// ------------------------------------------------------------------------ 7. money and cost

/** How one request's price stands, as `LogQueryService` reports it. */
const logPricingStatusDto = z.enum(["pending", "priced", "unpriced"]);

const logRequestCostDto = z.object({
  currency: z.literal("CNY"),
  status: logPricingStatusDto,
  reason: z.string().nullable(),
  amount: z.string().nullable(),
});

const logTaskCostDto = z.object({
  currency: z.literal("CNY"),
  known_amount: z.string().nullable(),
  pending_request_count: z.number().int().min(0),
  priced_request_count: z.number().int().min(0),
  unpriced_request_count: z.number().int().min(0),
});

export type AdminLogPricingStatus = AdminDto<typeof logPricingStatusDto>;
export type AdminLogRequestCost = AdminDto<typeof logRequestCostDto>;
export type AdminLogTaskCost = AdminDto<typeof logTaskCostDto>;

// --------------------------------------------------------------------- 8. history and groups

/**
 * One row of a task's request list. Every key here is written by `logListItem()`, so the
 * object is closed: a key the service stops writing disappears from the answer and shows up
 * in a contract test instead of reaching the browser as `undefined`.
 */
const logListItemDto = z.object({
  cost: logRequestCostDto.optional(),
  end_to_end_speed_tps: z.number().optional(),
  decode_speed_tps: z.number().optional(),
  has_summary: z.boolean(),
  id: z.string(),
  timestamp: z.string(),
  sequence: z.string(),
  method: z.string(),
  path: z.string(),
  endpoint: z.string(),
  message_count: z.number().int().nullable(),
  status: z.number().int().nullable(),
  request_token_count: z.number().int().nullable(),
  response_token_count: z.number().int().nullable(),
  target: z.string(),
});

/** A row still in flight: the batch read marks it so the console can keep polling it. */
const logPendingRecordDto = logListItemDto.extend({ pending: z.boolean() });

const logGroupLogsDto = z.object({
  id: z.string(),
  logs: z.array(logListItemDto),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  next_offset: z.number().int().min(0),
  has_more: z.boolean(),
});

const logGroupSummaryDto = z.object({
  cost: logTaskCostDto.optional(),
  decode_speed_tps: z.number().optional(),
  id: z.string(),
  last_activity_at: z.string(),
  model: z.string().nullable(),
  request_count: z.number().int().min(0),
  started_at: z.string(),
  target: z.string().nullable(),
  preview: logGroupLogsDto.optional(),
});

const logGroupPageDto = z.object({
  groups: z.array(logGroupSummaryDto),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  next_offset: z.number().int().min(0),
  has_more: z.boolean(),
});

const recordBatchDto = z.object({ records: z.array(logPendingRecordDto) });

/**
 * A single record. The keys are all this project writes, so the top level is closed; inside
 * it the halves that hold other people's JSON stay open — the client's request body, the
 * upstream answer, both meta blocks and the stored pricing block, which carries the matched
 * rule and the measured usage exactly as they arrived. Money stays text.
 *
 * The two meta blocks are declared optional although the service writes them on every detail.
 * `fast-json-stringify` prints required properties before optional ones, and only a finished
 * record carries `decode_window_ms`, so keeping the meta blocks required would print them
 * ahead of the measured window and change the order the answer arrives in.
 */
const logRecordDetailDto = z.object({
  id: z.string(),
  pending: z.boolean(),
  request: z.unknown(),
  response: z.unknown(),
  pricing: openRecord.nullable(),
  decode_window_ms: z.number().optional(),
  request_meta: openRecord.optional(),
  response_meta: openRecord.optional(),
});

/** A stored smart summary: the summary model's own JSON, kept verbatim. */
const historySummaryDto = z.looseObject({
  title: z.unknown().optional(),
  overview: z.unknown().optional(),
  segments: z.array(z.unknown()).optional(),
  decisions: z.unknown().optional(),
  issues: z.unknown().optional(),
});

/** What the summary model says about the newest request; the fact names are its own. */
const taskBriefDto = z.object({
  task_id: z.string(),
  text: z.string(),
  context: z.record(z.string(), z.string()).optional(),
  model: z.string().nullable(),
  generated_at: z.string(),
  source_record_id: z.string().nullable(),
});

/** What a cleanup answered: the groups it removed, and how many. */
const logCleanupResultDto = z.object({
  deleted: z.array(z.string()),
  deleted_count: z.number().int().min(0),
});

/**
 * One point of the per-request token series. Sequence order is the request order; a token
 * count that is still unknown is `null`, not missing.
 */
const tokenSeriesPointDto = z.object({
  sequence: z.number().int().min(0),
  request_tokens: z.number().int().nullable(),
  response_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
});

/** One priced request's own cost, in nano-CNY text. */
const costSeriesPointDto = z.object({
  sequence: z.number().int().min(0),
  cost_nano_cny: z.string(),
});

/** One request's own output tokens. */
const outputTokenSeriesPointDto = z.object({
  sequence: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
});

/** The four token buckets of a price calculation, in text to keep precision. */
const pricingBreakdownDto = z.object({
  input_uncached: pricingBucketDto,
  output: pricingBucketDto,
  cache_read: pricingBucketDto,
  cache_write: pricingBucketDto,
});

/**
 * A task's whole price: the project's own arithmetic over stored rows, so every key is
 * declared and the object is closed. `active_request_ms` is a measured duration and may be
 * fractional, which is why it is not declared as an integer.
 */
const taskPricingDto = z.object({
  target: z.string().nullable(),
  active_request_ms: z.number(),
  total_request_ms: z.number().nullable(),
  cost_nano_cny: z.string().nullable(),
  priced_request_count: z.number().int().min(0),
  unpriced_request_count: z.number().int().min(0),
  pending_request_count: z.number().int().min(0),
  unpriced_reasons: z.record(z.string(), z.number()),
  breakdown: pricingBreakdownDto,
  groups: z.array(
    z.object({
      billing_model: z.string().nullable(),
      algorithm_version: z.number().int().nullable(),
      price: pricingPriceDto,
      request_count: z.number().int().min(0),
      cost_nano_cny: z.string(),
      breakdown: pricingBreakdownDto,
    }),
  ),
});

export type AdminLogListItem = AdminDto<typeof logListItemDto>;
export type AdminLogPendingRecord = AdminDto<typeof logPendingRecordDto>;
export type AdminLogGroupLogs = AdminDto<typeof logGroupLogsDto>;
export type AdminLogGroupSummary = AdminDto<typeof logGroupSummaryDto>;
export type AdminLogGroupPage = AdminDto<typeof logGroupPageDto>;
export type AdminRecordBatch = AdminDto<typeof recordBatchDto>;
export type AdminLogRecordDetail = AdminDto<typeof logRecordDetailDto>;
export type AdminHistorySummary = AdminDto<typeof historySummaryDto>;
export type AdminTaskBrief = AdminDto<typeof taskBriefDto>;
export type AdminLogCleanupResult = AdminDto<typeof logCleanupResultDto>;
export type AdminTokenSeriesPoint = AdminDto<typeof tokenSeriesPointDto>;
export type AdminCostSeriesPoint = AdminDto<typeof costSeriesPointDto>;
export type AdminOutputTokenSeriesPoint = AdminDto<typeof outputTokenSeriesPointDto>;
export type AdminPricingBucket = AdminDto<typeof pricingBucketDto>;
export type AdminPricingPrice = AdminDto<typeof pricingPriceDto>;
export type AdminPricingBreakdown = AdminDto<typeof pricingBreakdownDto>;
export type AdminTaskPricing = AdminDto<typeof taskPricingDto>;

export const LOG_GROUP_PAGE_SCHEMA = toAdminJsonSchema(logGroupPageDto);
export const LOG_GROUP_LOGS_SCHEMA = toAdminJsonSchema(logGroupLogsDto);
export const LOG_RECORDS_SCHEMA = toAdminJsonSchema(recordBatchDto);
export const LOG_RECORD_DETAIL_SCHEMA = toAdminJsonSchema(logRecordDetailDto);
export const LOG_GROUP_PRICING_SCHEMA = toAdminJsonSchema(taskPricingDto);
export const LOG_GROUP_TOKEN_SERIES_SCHEMA = toAdminJsonSchema(z.array(tokenSeriesPointDto));
export const LOG_GROUP_COST_SERIES_SCHEMA = toAdminJsonSchema(z.array(costSeriesPointDto));
export const LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA = toAdminJsonSchema(
  z.array(outputTokenSeriesPointDto),
);
export const HISTORY_SUMMARY_SCHEMA = toAdminJsonSchema(historySummaryDto);
export const TASK_BRIEF_SCHEMA = toAdminJsonSchema(taskBriefDto);
export const LOG_CLEANUP_RESPONSE_SCHEMA = toAdminJsonSchema(logCleanupResultDto);

/**
 * The two reads that answer "nothing is stored here" with `null` instead of a 404: the
 * stored summary and the stored brief. The absent case is part of the contract, so it is
 * declared as part of the schema rather than left to the serializer to guess.
 */
export const HISTORY_SUMMARY_RESPONSE_SCHEMA = toAdminJsonSchema(historySummaryDto.nullable());
export const TASK_BRIEF_RESPONSE_SCHEMA = toAdminJsonSchema(taskBriefDto.nullable());

// ------------------------------------------------------------- 9. query and path parameters

/** The one path parameter every `/api/.../:id` route reads. */
export const PATH_ID_PARAMS_SCHEMA = toAdminJsonSchema(pathId);

const logGroupQueryDto = z.object({
  q: z.string().default(""),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

const groupLogQueryDto = z.object({
  q: z.string().default(""),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

/** The batch read needs at least one id; the route splits the comma-separated list. */
const recordIdsQueryDto = z.object({ ids: z.string().min(1).max(16_384) });

/**
 * One cleanup call names exactly one strategy. `minProperties` and `uniqueItems` are the two
 * keywords Zod cannot express — its own JSON-Schema reader lists both as unsupported — so
 * they ride along as schema metadata, which `toJSONSchema` merges into the output. That is
 * how this route has always rejected an empty body and a repeated group id.
 */
const cleanupGroupIdsDto = z.array(z.string().min(1)).min(1).meta({ uniqueItems: true });

const logCleanupRequestDto = z
  .object({
    group_ids: cleanupGroupIdsDto.optional(),
    older_than_days: z.number().int().min(0).optional(),
    keep_latest: z.number().int().min(0).optional(),
  })
  .meta({ minProperties: 1 });

export const LOG_GROUP_QUERY_SCHEMA = toAdminJsonSchema(logGroupQueryDto);
export const GROUP_LOG_QUERY_SCHEMA = toAdminJsonSchema(groupLogQueryDto);
export const RECORD_IDS_QUERY_SCHEMA = toAdminJsonSchema(recordIdsQueryDto);
export const LOG_CLEANUP_REQUEST_SCHEMA = toAdminJsonSchema(logCleanupRequestDto);

/**
 * The request side of a declared schema: what the client may send, before the defaults in
 * the schema are applied. A handler still writes `?? 100` because that is the value the
 * validator fills in when the key is absent, and the type has to say the same thing.
 */
export type AdminPathParams = z.input<typeof pathId>;
export type AdminLogGroupQuery = z.input<typeof logGroupQueryDto>;
export type AdminGroupLogQuery = z.input<typeof groupLogQueryDto>;
export type AdminRecordIdsQuery = z.input<typeof recordIdsQueryDto>;
export type AdminCleanupRequestBody = z.input<typeof logCleanupRequestDto>;

// -------------------------------------------------------------------- 10. usage statistics

/** The window every statistics query is given; both ends are full ISO instants. */
const statisticsWindowDto = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** How a trend is split inside a bucket, and over which metric a summary is ranked. */
const statisticsBreakdownDto = z.enum(["total", "model", "target"]);
const statisticsMetricDto = z.enum(["token", "cost"]);
const statisticsGranularityDto = z.enum(["day", "week", "month", "auto"]);

const statisticsQueryDto = statisticsWindowDto.extend({
  metric: statisticsMetricDto.optional(),
  targetId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  granularity: statisticsGranularityDto.optional(),
  timezoneOffset: z.number().int().min(-840).max(840).optional(),
  breakdown: statisticsBreakdownDto.optional(),
});

/** The two routes that only need a window, optionally narrowed to one target. */
const statisticsWindowWithOptionsDto = statisticsWindowDto.extend({
  targetId: z.string().min(1).max(200).optional(),
});

const statisticsExportQueryDto = statisticsWindowDto.extend({
  targetId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  granularity: statisticsGranularityDto.optional(),
  timezoneOffset: z.number().int().min(-840).max(840).optional(),
});

/** Token and money totals are text: a window can hold more tokens than a double holds. */
const statisticsTotalsDto = z.object({
  requests: z.number().int().min(0),
  tasks: z.number().int().min(0),
  input: z.string(),
  output: z.string(),
  cache_read: z.string(),
  cache_write: z.string(),
  cost: z.string(),
});

const statisticsBucketDto = z.object({
  id: z.string(),
  requests: z.number().int().min(0),
  tasks: z.number().int().min(0),
  input: z.string(),
  output: z.string(),
  cache_read: z.string(),
  cache_write: z.string(),
  cost: z.string(),
  value: z.string(),
});

const statisticsOverviewDto = z.object({
  dataVersion: z.literal(1),
  totals: statisticsTotalsDto,
  byTarget: z.array(statisticsBucketDto),
  byModel: z.array(statisticsBucketDto),
  unpriced: z.record(z.string(), z.number()),
});

const statisticsBreakdownEntryDto = z.object({
  id: z.string(),
  requests: z.number().int().min(0),
  tasks: z.number().int().min(0),
  input: z.string(),
  output: z.string(),
  cache_read: z.string(),
  cache_write: z.string(),
  cost: z.string(),
  unpriced: z.number().int().min(0),
});

const statisticsTrendPointDto = z.object({
  bucket: z.string(),
  requests: z.number().int().min(0),
  tasks: z.number().int().min(0),
  input: z.string(),
  output: z.string(),
  cache_read: z.string(),
  cache_write: z.string(),
  cost: z.string(),
  unpriced: z.number().int().min(0),
  by_model: z.array(statisticsBreakdownEntryDto),
  by_target: z.array(statisticsBreakdownEntryDto),
});

const statisticsTrendDto = z.object({
  dataVersion: z.literal(1),
  granularity: z.string(),
  points: z.array(statisticsTrendPointDto),
});

const statisticsOptionsDto = z.object({
  targets: z.array(z.object({ id: z.string(), name: z.string() })),
  models: z.array(z.string()),
});

export type AdminStatisticsTotals = AdminDto<typeof statisticsTotalsDto>;
export type AdminStatisticsBucket = AdminDto<typeof statisticsBucketDto>;
export type AdminStatisticsOverview = AdminDto<typeof statisticsOverviewDto>;
export type AdminStatisticsBreakdownEntry = AdminDto<typeof statisticsBreakdownEntryDto>;
export type AdminStatisticsTrendPoint = AdminDto<typeof statisticsTrendPointDto>;
export type AdminStatisticsTrend = AdminDto<typeof statisticsTrendDto>;
export type AdminStatisticsOptions = AdminDto<typeof statisticsOptionsDto>;
export type AdminStatisticsMetric = AdminDto<typeof statisticsMetricDto>;
export type AdminUsageStatisticsBreakdown = AdminDto<typeof statisticsBreakdownDto>;
export type AdminStatisticsGranularity = AdminDto<typeof statisticsGranularityDto>;

export const STATISTICS_QUERY_SCHEMA = toAdminJsonSchema(statisticsQueryDto);
export const STATISTICS_WINDOW_QUERY_SCHEMA = toAdminJsonSchema(statisticsWindowWithOptionsDto);
export const STATISTICS_EXPORT_QUERY_SCHEMA = toAdminJsonSchema(statisticsExportQueryDto);
export const STATISTICS_OVERVIEW_RESPONSE_SCHEMA = toAdminJsonSchema(statisticsOverviewDto);
export const STATISTICS_TREND_RESPONSE_SCHEMA = toAdminJsonSchema(statisticsTrendDto);
export const STATISTICS_OPTIONS_RESPONSE_SCHEMA = toAdminJsonSchema(statisticsOptionsDto);

export type AdminStatisticsQuery = z.input<typeof statisticsQueryDto>;
export type AdminStatisticsWindowQuery = z.input<typeof statisticsWindowWithOptionsDto>;
export type AdminStatisticsExportQuery = z.input<typeof statisticsExportQueryDto>;

// -------------------------------------------------------------- 11. summary model settings

/**
 * The summary model's own configuration, as the configuration module owns it. The wire
 * structure is declared here so the route can check the shape of a save, while the field
 * rules stay with `summaryModelConfigSchema`: a bad URL, an empty model name or a header
 * line without a colon comes back as `invalid_config` with the offending paths, which is
 * what the browser points at. That schema uses `.refine()`, which no JSON Schema can
 * express, so duplicating those rules here would only split one rule across two places.
 */
const summaryModelConfigDto = z.object({
  disable_reasoning: z.boolean(),
  api_type: z.enum(["openai_chat", "openai_responses", "anthropic_messages"]),
  target_url: z.string(),
  api_key: z.string(),
  model: z.string(),
  target_headers: z.array(z.string()),
  timeout_ms: z.number(),
});

const summaryModelTestResponseDto = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export type AdminSummaryModelConfig = AdminDto<typeof summaryModelConfigDto>;
export type AdminSummaryModelTestResult = AdminDto<typeof summaryModelTestResponseDto>;

export const SUMMARY_MODEL_CONFIG_SCHEMA = toAdminJsonSchema(summaryModelConfigDto);
export const SUMMARY_MODEL_TEST_RESPONSE_SCHEMA = toAdminJsonSchema(summaryModelTestResponseDto);

/** The stored settings, or `null` when no summary model has been configured yet. */
export const SUMMARY_MODEL_CONFIG_RESPONSE_SCHEMA = toAdminJsonSchema(
  summaryModelConfigDto.nullable(),
);

export type AdminSummaryModelConfigInput = z.input<typeof summaryModelConfigDto>;
