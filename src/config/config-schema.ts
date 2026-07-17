import { z } from "zod";

export const modelMappingSchema = z.object({
  listen: z.string().trim().min(1, "listen model is required"),
  upstream: z.string().trim().min(1, "upstream model is required"),
});

export type ModelMapping = z.infer<typeof modelMappingSchema>;

export const targetConfigSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean(),
  target_url: z.string(),
  target_api_key: z.string(),
  target_headers: z.array(z.string()),
  strip_request_fields: z.string(),
  inject_request_fields: z.string(),
  timeout: z.number(),
  log_root: z.string(),
  redact_logs: z.boolean(),
  model_mappings: z.array(modelMappingSchema),
});

export type TargetConfig = z.infer<typeof targetConfigSchema>;

export const proxyPairSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean(),
  listen_host: z.string(),
  listen_port: z.number(),
  access_log: z.boolean(),
  targets: z.array(targetConfigSchema).min(1),
  default_target_id: z.string().trim().min(1),
});

export const proxyConfigFileSchema = z.object({
  pairs: z.array(proxyPairSchema),
});

export type ProxyPair = z.infer<typeof proxyPairSchema>;
export type ProxyConfigFile = z.infer<typeof proxyConfigFileSchema>;
