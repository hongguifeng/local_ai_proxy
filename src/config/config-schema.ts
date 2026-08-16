import { z } from "zod";

const MAX_PORT = 65_535;

const targetUrlSchema = z
  .string()
  .trim()
  .min(1, "target URL is required")
  .refine(isValidTargetUrl, "target URL must be http(s)://host[:port][/base-path]");

const headerOverrideSchema = z
  .string()
  .refine((value) => value.includes(":"), "header override must use 'Name: value'")
  .refine((value) => value.split(":", 1)[0]?.trim() !== "", "header name is required");

const injectRequestFieldsSchema = z.string().refine(isJsonObjectText, {
  message: "inject request fields must be an empty string or JSON object",
});

export const modelMappingSchema = z.object({
  listen: z.string().trim().min(1, "listen model is required"),
  upstream: z.string().trim().min(1, "upstream model is required"),
});

export type ModelMapping = z.infer<typeof modelMappingSchema>;

export const targetConfigSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean(),
  target_url: targetUrlSchema,
  target_api_key: z.string(),
  target_headers: z.array(headerOverrideSchema),
  strip_request_fields: z.string(),
  inject_request_fields: injectRequestFieldsSchema,
  log_root: z.string(),
  redact_logs: z.boolean(),
  model_mappings: z.array(modelMappingSchema),
});

export type TargetConfig = z.infer<typeof targetConfigSchema>;

export const proxyPairSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean(),
  listen_host: z.string().trim().min(1),
  listen_port: z.number().int().min(0).max(MAX_PORT),
  access_log: z.boolean(),
  targets: z.array(targetConfigSchema).min(1),
  default_target_id: z.string().trim().min(1),
});

export const proxyConfigFileSchema = z
  .object({
    pairs: z.array(proxyPairSchema),
  })
  .superRefine(({ pairs }, context) => {
    const pairIds = new Set<string>();
    for (const [pairIndex, pair] of pairs.entries()) {
      if (pairIds.has(pair.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate proxy pair id: ${pair.id}`,
          path: ["pairs", pairIndex, "id"],
        });
      }
      pairIds.add(pair.id);

      const targetIds = new Set<string>();
      for (const [targetIndex, target] of pair.targets.entries()) {
        if (targetIds.has(target.id)) {
          context.addIssue({
            code: "custom",
            message: `duplicate target id in pair ${pair.id}: ${target.id}`,
            path: ["pairs", pairIndex, "targets", targetIndex, "id"],
          });
        }
        targetIds.add(target.id);
      }
    }
  });

export type ProxyPair = z.infer<typeof proxyPairSchema>;
export type ProxyConfigFile = z.infer<typeof proxyConfigFileSchema>;

function isValidTargetUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function isJsonObjectText(value: string): boolean {
  if (value.trim() === "") {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
