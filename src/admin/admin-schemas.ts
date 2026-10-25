export const HEALTH_SNAPSHOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["applicationState", "status", "version"],
  properties: {
    applicationState: { type: "string" },
    status: { type: "string", enum: ["degraded", "ok", "starting", "stopping"] },
    version: { type: "string" },
  },
} as const;

export const ADMIN_ERROR_DTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "path"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              path: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export const PAIRS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

export const REPLACE_PAIRS_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

export const SET_PAIR_ENABLED_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

export const TARGET_CHECK_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetUrl", "model"],
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^https?://" },
    model: { type: "string", minLength: 1, maxLength: 512 },
    apiType: { type: "string", enum: ["chat", "responses", "anthropic"] },
    apiKey: { type: "string", maxLength: 65_536 },
  },
} as const;

export const MODEL_PRICES_IMPORT_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetUrl"],
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^https?://" },
    targetApiKey: { type: "string", maxLength: 65_536 },
    priceRate: {
      type: "string",
      maxLength: 30,
      pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$",
    },
  },
} as const;

export const MODEL_PRICES_IMPORT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["models", "rules", "unmatched", "catalog"],
  properties: {
    models: { type: "array", items: { type: "string", minLength: 1 } },
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "model_pattern",
          "input_per_million",
          "output_per_million",
          "cache_read_per_million",
          "cache_write_per_million",
        ],
        properties: {
          model_pattern: { type: "string", minLength: 1 },
          input_per_million: { type: "string" },
          output_per_million: { type: "string" },
          cache_read_per_million: { type: "string" },
          cache_write_per_million: { type: "string" },
        },
      },
    },
    unmatched: { type: "array", items: { type: "string", minLength: 1 } },
    catalog: {
      type: "object",
      additionalProperties: false,
      required: ["source", "fetchedAt"],
      properties: {
        source: { type: "string", minLength: 1 },
        fetchedAt: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

export const TARGET_CHECK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "durationMs"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "integer", minimum: 100, maximum: 599 },
    durationMs: { type: "number", minimum: 0 },
    error: { type: "string", maxLength: 8_192 },
    detail: { type: "string", maxLength: 8_192 },
  },
} as const;

export const TARGET_METRICS_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetUrl"],
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^https?://" },
    apiKey: { type: "string", maxLength: 65_536 },
  },
} as const;

export const TARGET_METRICS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "durationMs"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "integer", minimum: 100, maximum: 599 },
    durationMs: { type: "number", minimum: 0 },
    text: { type: "string", maxLength: 1_048_576 },
    truncated: { type: "boolean" },
    error: { type: "string", maxLength: 8_192 },
  },
} as const;

export const TARGET_MODELS_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetUrl"],
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^https?://" },
    apiKey: { type: "string", maxLength: 65_536 },
  },
} as const;

export const TARGET_MODELS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "models", "durationMs"],
  properties: {
    ok: { type: "boolean" },
    models: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 1_000 },
    truncated: { type: "boolean" },
    durationMs: { type: "number", minimum: 0 },
    error: { type: "string", maxLength: 8_192 },
  },
} as const;

const LOAD_BALANCER_NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "bindings",
    "canonicalKey",
    "cooldownRemainingMs",
    "enabled",
    "failures",
    "inFlight",
    "inRotation",
    "lastDispatchedAt",
    "metrics",
    "stale",
    "targetId",
  ],
  properties: {
    bindings: { type: "integer", minimum: 0 },
    canonicalKey: { type: "string", maxLength: 8_192 },
    cooldownRemainingMs: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
    failures: { type: "integer", minimum: 0 },
    inFlight: { type: "integer", minimum: 0 },
    inRotation: { type: "boolean" },
    lastDispatchedAt: { type: ["integer", "null"] },
    metrics: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["running", "waiting", "sampledAt", "source"],
      properties: {
        kvUsage: { type: ["number", "null"] },
        running: { type: "integer", minimum: 0 },
        sampledAt: { type: "integer", minimum: 0 },
        source: { type: "string", maxLength: 256 },
        waiting: { type: "integer", minimum: 0 },
      },
    },
    stale: { type: "boolean" },
    targetId: { type: "string", maxLength: 512 },
  },
} as const;

const LOAD_BALANCER_GROUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "bindings",
    "enabled",
    "failoverEnabled",
    "id",
    "metricsEnabled",
    "modelPattern",
    "name",
    "nodeTargetIds",
    "nodes",
    "strategy",
  ],
  properties: {
    bindings: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
    failoverEnabled: { type: "boolean" },
    id: { type: "string", maxLength: 512 },
    metricsEnabled: { type: "boolean" },
    modelPattern: { type: "string", maxLength: 512 },
    name: { type: "string", maxLength: 512 },
    nodeTargetIds: { type: "array", maxItems: 256, items: { type: "string", maxLength: 512 } },
    nodes: { type: "array", maxItems: 256, items: LOAD_BALANCER_NODE_SCHEMA },
    strategy: { type: "string", maxLength: 64 },
  },
} as const;

export const LOAD_BALANCER_STATUS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["now", "pairs"],
  properties: {
    now: { type: "integer", minimum: 0 },
    pairs: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "groups", "id", "name", "running"],
        properties: {
          enabled: { type: "boolean" },
          groups: { type: "array", maxItems: 256, items: LOAD_BALANCER_GROUP_SCHEMA },
          id: { type: "string", maxLength: 512 },
          name: { type: "string", maxLength: 512 },
          running: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const PAIR_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pair"],
  properties: { pair: { type: "object", additionalProperties: true } },
} as const;

export const LOG_GROUP_PAGE_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const LOG_GROUP_LOGS_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const LOG_GROUP_TOKEN_SERIES_SCHEMA = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

export const LOG_GROUP_COST_SERIES_SCHEMA = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

export const LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

export const LOG_RECORD_DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const LOG_RECORDS_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;
