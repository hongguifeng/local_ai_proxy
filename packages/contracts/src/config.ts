import { z } from "zod";

import { EntityIdSchema } from "./common.js";

export const DEFAULT_REQUEST_CAPTURE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RESPONSE_CAPTURE_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

export const HeaderOverrideSchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  value: z.string().max(16_384),
});

export const ModelMappingSchema = z.strictObject({
  listen: z.string().trim().min(1).max(256),
  upstream: z.string().trim().min(1).max(256),
});

export const TimeoutConfigSchema = z.strictObject({
  connectMs: z.number().int().min(100).max(120_000).default(10_000),
  responseHeadersMs: z.number().int().min(100).max(600_000).default(60_000),
  idleMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
});

export const CaptureConfigSchema = z.strictObject({
  maxRequestBodyBytes: z.number().int().min(1).max(MAX_CAPTURE_BYTES).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  requestBytes: z.number().int().min(0).max(MAX_CAPTURE_BYTES).default(DEFAULT_REQUEST_CAPTURE_BYTES),
  responseBytes: z.number().int().min(0).max(MAX_CAPTURE_BYTES).default(DEFAULT_RESPONSE_CAPTURE_BYTES),
});

export const RetentionConfigSchema = z.strictObject({
  days: z.number().int().min(0).max(3_650).default(DEFAULT_RETENTION_DAYS),
});

export const TargetConfigSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  url: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "Target URL must use HTTP or HTTPS",
  }),
  targetApiKey: z.string().max(16_384).default(""),
  headers: z.array(HeaderOverrideSchema).max(100).default([]),
  stripRequestFields: z.array(z.string().min(1).max(256)).max(100).default([]),
  injectRequestFields: z.record(z.string(), z.json()).default({}),
  timeouts: TimeoutConfigSchema.default({
    connectMs: 10_000,
    responseHeadersMs: 60_000,
    idleMs: 600_000,
  }),
  logRoot: z.string().max(32_768).nullable().default(null),
  redactLogs: z.boolean().default(false),
  modelMappings: z.array(ModelMappingSchema).max(1_000).default([]),
});

export const ProxyConfigSchema = z
  .strictObject({
    id: EntityIdSchema,
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(false),
    listenHost: z.string().trim().min(1).max(253).default("127.0.0.1"),
    listenPort: z.number().int().min(0).max(65_535).default(1234),
    accessLog: z.boolean().default(false),
    targets: z.array(TargetConfigSchema).min(1).max(100),
    defaultTargetId: EntityIdSchema,
  })
  .superRefine((proxy, context) => {
    const targetIds = new Set<string>();
    for (const [index, target] of proxy.targets.entries()) {
      if (targetIds.has(target.id)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "id"],
          message: `Duplicate target ID: ${target.id}`,
        });
      }
      targetIds.add(target.id);

      const listenModels = new Set<string>();
      for (const [mappingIndex, mapping] of target.modelMappings.entries()) {
        if (listenModels.has(mapping.listen)) {
          context.addIssue({
            code: "custom",
            path: ["targets", index, "modelMappings", mappingIndex, "listen"],
            message: `Duplicate listen model: ${mapping.listen}`,
          });
        }
        listenModels.add(mapping.listen);
      }
    }
    if (!targetIds.has(proxy.defaultTargetId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultTargetId"],
        message: "Default target does not exist",
      });
    }
  });

export const ConfigV1Schema = z
  .strictObject({
    version: z.literal(1),
    proxies: z.array(ProxyConfigSchema).max(100).default([]),
    capture: CaptureConfigSchema.default({
      maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
      requestBytes: DEFAULT_REQUEST_CAPTURE_BYTES,
      responseBytes: DEFAULT_RESPONSE_CAPTURE_BYTES,
    }),
    retention: RetentionConfigSchema.default({ days: DEFAULT_RETENTION_DAYS }),
  })
  .superRefine((config, context) => {
    const proxyIds = new Set<string>();
    const listeners = new Set<string>();
    for (const [index, proxy] of config.proxies.entries()) {
      if (proxyIds.has(proxy.id)) {
        context.addIssue({
          code: "custom",
          path: ["proxies", index, "id"],
          message: `Duplicate proxy ID: ${proxy.id}`,
        });
      }
      proxyIds.add(proxy.id);
      const listener = [proxy.listenHost.toLowerCase(), proxy.listenPort].join(":");
      if (listeners.has(listener)) {
        context.addIssue({
          code: "custom",
          path: ["proxies", index, "listenPort"],
          message: `Duplicate listen address: ${listener}`,
        });
      }
      listeners.add(listener);
    }
  });

export type HeaderOverride = z.infer<typeof HeaderOverrideSchema>;
export type ModelMapping = z.infer<typeof ModelMappingSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ConfigV1 = z.infer<typeof ConfigV1Schema>;
