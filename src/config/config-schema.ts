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
