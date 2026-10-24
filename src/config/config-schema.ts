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

const MAX_PRICE_PER_MILLION_MICROS = 1_000_000_000_000n;
const decimalPricePattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;

const pricePerMillionSchema = z.string().refine(isValidPricePerMillion, {
  message:
    "price must be a non-negative decimal string with at most 6 decimal places and no more than 1000000",
});

export const modelPriceSchema = z.object({
  model_pattern: z.string().trim().min(1, "model pattern is required"),
  price_multiplier: pricePerMillionSchema.optional(),
  input_per_million: pricePerMillionSchema,
  output_per_million: pricePerMillionSchema,
  cache_read_per_million: pricePerMillionSchema,
  cache_write_per_million: pricePerMillionSchema,
});

export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const loadBalancerStrategySchema = z.enum(["least_load", "round_robin"]);
export type LoadBalancerStrategy = z.infer<typeof loadBalancerStrategySchema>;

/**
 * One load balancing group inside a proxy pair. Group members are existing
 * targets of the same pair; the group only decides which node serves a request
 * and which model name is forwarded, every other target setting still applies.
 */
export const loadBalancerGroupSchema = z
  .object({
    id: z.string().trim().min(1, "load balancer group id is required"),
    name: z.string(),
    enabled: z.boolean().default(true),
    model_pattern: z.string().trim().min(1, "load balancer model pattern is required"),
    node_target_ids: z
      .array(z.string().trim().min(1, "load balancer node target id is required"))
      .min(1, "load balancer group needs at least one node target"),
    strategy: loadBalancerStrategySchema.default("least_load"),
    metrics_enabled: z.boolean().default(true),
    failover_enabled: z.boolean().default(true),
  })
  .superRefine(({ id, node_target_ids: nodeTargetIds }, context) => {
    const seen = new Set<string>();
    for (const [index, targetId] of nodeTargetIds.entries()) {
      if (seen.has(targetId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate load balancer node target in group ${id}: ${targetId}`,
          path: ["node_target_ids", index],
        });
      }
      seen.add(targetId);
    }
  });

export type LoadBalancerGroup = z.infer<typeof loadBalancerGroupSchema>;

export const targetConfigSchema = z
  .object({
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
    model_prices: z.array(modelPriceSchema).default([]),
  })
  .superRefine(({ model_prices: modelPrices }, context) => {
    const patterns = new Set<string>();
    for (const [index, price] of modelPrices.entries()) {
      if (patterns.has(price.model_pattern)) {
        context.addIssue({
          code: "custom",
          message: `duplicate model price pattern: ${price.model_pattern}`,
          path: ["model_prices", index, "model_pattern"],
        });
      }
      patterns.add(price.model_pattern);
    }
  });

export type TargetConfig = z.infer<typeof targetConfigSchema>;

export const summaryModelConfigSchema = z.object({
  disable_reasoning: z.boolean().default(true),
  api_type: z.enum(["openai_chat", "openai_responses", "anthropic_messages"]),
  target_url: targetUrlSchema,
  api_key: z.string(),
  model: z.string().trim().min(1),
  target_headers: z.array(headerOverrideSchema).default([]),
  timeout_ms: z.number().int().min(1000).max(604800000).default(180000),
});
export type SummaryModelConfig = z.infer<typeof summaryModelConfigSchema>;

export const proxyPairSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean(),
  listen_host: z.string().trim().min(1),
  listen_port: z.number().int().min(0).max(MAX_PORT),
  access_log: z.boolean(),
  targets: z.array(targetConfigSchema).min(1),
  default_target_id: z.string().trim().min(1),
  load_balancers: z.array(loadBalancerGroupSchema).default([]),
});

export const proxyConfigFileSchema = z
  .object({
    pairs: z.array(proxyPairSchema),
    summary_model: summaryModelConfigSchema.optional(),
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

      const targetsById = new Map(pair.targets.map((target) => [target.id, target]));
      const groupIds = new Set<string>();
      const exactPatterns = new Set<string>();
      for (const [groupIndex, group] of pair.load_balancers.entries()) {
        if (groupIds.has(group.id)) {
          context.addIssue({
            code: "custom",
            message: `duplicate load balancer id in pair ${pair.id}: ${group.id}`,
            path: ["pairs", pairIndex, "load_balancers", groupIndex, "id"],
          });
        }
        groupIds.add(group.id);

        if (exactPatterns.has(group.model_pattern)) {
          context.addIssue({
            code: "custom",
            message: `duplicate load balancer model pattern in pair ${pair.id}: ${group.model_pattern}`,
            path: ["pairs", pairIndex, "load_balancers", groupIndex, "model_pattern"],
          });
        }
        exactPatterns.add(group.model_pattern);

        const members: { readonly nodeIndex: number; readonly target: TargetConfig }[] = [];
        for (const [nodeIndex, targetId] of group.node_target_ids.entries()) {
          const target = targetsById.get(targetId);
          if (target === undefined) {
            context.addIssue({
              code: "custom",
              message: `load balancer node target not found in pair ${pair.id}: ${targetId}`,
              path: [
                "pairs",
                pairIndex,
                "load_balancers",
                groupIndex,
                "node_target_ids",
                nodeIndex,
              ],
            });
            continue;
          }
          members.push({ nodeIndex, target });
        }

        const reference = members[0];
        if (reference === undefined) {
          continue;
        }
        for (const member of members.slice(1)) {
          if (!sameResolvedLogRoot(reference.target.log_root, member.target.log_root)) {
            context.addIssue({
              code: "custom",
              message: `load balancer group ${group.id} nodes must share one log root: ${reference.target.id} uses "${reference.target.log_root}" but ${member.target.id} uses "${member.target.log_root}"`,
              path: [
                "pairs",
                pairIndex,
                "load_balancers",
                groupIndex,
                "node_target_ids",
                member.nodeIndex,
              ],
            });
          }
          if (!sameModelPriceRules(reference.target.model_prices, member.target.model_prices)) {
            context.addIssue({
              code: "custom",
              message: `load balancer group ${group.id} nodes must share identical model prices: ${reference.target.id} differs from ${member.target.id}`,
              path: [
                "pairs",
                pairIndex,
                "load_balancers",
                groupIndex,
                "node_target_ids",
                member.nodeIndex,
              ],
            });
          }
        }
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

function isValidPricePerMillion(value: string): boolean {
  if (!decimalPricePattern.test(value)) {
    return false;
  }
  const [integer, fraction = ""] = value.split(".");
  if (integer === undefined) {
    return false;
  }
  const micros = BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micros <= MAX_PRICE_PER_MILLION_MICROS;
}

/**
 * Load balancing members must write into one traffic database, otherwise a single
 * task is split across two databases and its history, context links and pricing
 * statistics cannot agree. An empty root means "no traffic log" and only matches
 * another empty root. Comparison is case sensitive on purpose: accepting two
 * different Linux directories as one would silently split tasks.
 */
export function sameResolvedLogRoot(left: string, right: string): boolean {
  return resolvedLogRootKey(left) === resolvedLogRootKey(right);
}

function resolvedLogRootKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  const stack: string[] = [];
  for (const rawSegment of trimmed.replace(/\\/gu, "/").split("/")) {
    const segment = rawSegment.trim();
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/** Order, pattern and price of every rule must agree across group members. */
export function sameModelPriceRules(
  left: readonly ModelPrice[],
  right: readonly ModelPrice[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (const [index, rule] of left.entries()) {
    const other = right[index];
    if (other === undefined || !sameModelPriceRule(rule, other)) {
      return false;
    }
  }
  return true;
}

function sameModelPriceRule(left: ModelPrice, right: ModelPrice): boolean {
  return (
    left.model_pattern === right.model_pattern &&
    samePriceText(left.input_per_million, right.input_per_million) &&
    samePriceText(left.output_per_million, right.output_per_million) &&
    samePriceText(left.cache_read_per_million, right.cache_read_per_million) &&
    samePriceText(left.cache_write_per_million, right.cache_write_per_million) &&
    sameOptionalPriceText(left.price_multiplier, right.price_multiplier)
  );
}

function samePriceText(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftMicros = priceMicros(left);
  return leftMicros !== undefined && leftMicros === priceMicros(right);
}

function sameOptionalPriceText(left: string | undefined, right: string | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return priceMicros(left) === priceMicros(right);
}

function priceMicros(value: string): bigint | undefined {
  if (!decimalPricePattern.test(value)) {
    return undefined;
  }
  const [integer, fraction = ""] = value.split(".");
  if (integer === undefined) {
    return undefined;
  }
  return BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

interface ModelPatternConstraints {
  readonly prefix: string | undefined;
  readonly suffix: string | undefined;
  readonly middle: readonly string[];
}

/**
 * Decide whether two model patterns can match the same model name. The answer is
 * exact for the `*` glob syntax used by model mappings: patterns are provably
 * disjoint when their prefix, suffix or required middle segments contradict.
 */
export function modelPatternsMayOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const first = modelPatternConstraints(left);
  const second = modelPatternConstraints(right);
  if (!prefixesCompatible(first.prefix, second.prefix)) {
    return false;
  }
  if (!suffixesCompatible(first.suffix, second.suffix)) {
    return false;
  }
  return !middleSegmentsConflict(first.middle, second.middle);
}

function modelPatternConstraints(pattern: string): ModelPatternConstraints {
  const segments = pattern.split("*");
  return {
    prefix: pattern.startsWith("*") ? undefined : (segments[0] ?? ""),
    suffix: pattern.endsWith("*") ? undefined : (segments.at(-1) ?? ""),
    middle: segments.slice(1, -1).filter((segment) => segment !== ""),
  };
}

function prefixesCompatible(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }
  return left.startsWith(right) || right.startsWith(left);
}

function suffixesCompatible(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }
  return left.endsWith(right) || right.endsWith(left);
}

function middleSegmentsConflict(left: readonly string[], right: readonly string[]): boolean {
  const shared = left.filter(
    (segment, index) => right.includes(segment) && left.indexOf(segment) === index,
  );
  let previousIndex = -1;
  for (const segment of shared) {
    const index = right.indexOf(segment);
    if (index <= previousIndex) {
      return true;
    }
    previousIndex = index;
  }
  return false;
}

export type LoadBalancerWarningCode = "single_node" | "disabled_member" | "overlapping_pattern";

/** Advisory findings that are valid configuration but worth showing in the UI. */
export interface LoadBalancerWarning {
  readonly group_id: string;
  readonly group_index: number;
  readonly code: LoadBalancerWarningCode;
  readonly related_group_ids: readonly string[];
  readonly related_target_ids: readonly string[];
}

export function collectLoadBalancerWarnings(pair: ProxyPair): LoadBalancerWarning[] {
  const warnings: LoadBalancerWarning[] = [];
  const targetsById = new Map(pair.targets.map((target) => [target.id, target]));
  for (const [groupIndex, group] of pair.load_balancers.entries()) {
    if (group.node_target_ids.length === 1) {
      warnings.push({
        group_id: group.id,
        group_index: groupIndex,
        code: "single_node",
        related_group_ids: [],
        related_target_ids: [...group.node_target_ids],
      });
    }
    const disabledTargetIds = group.node_target_ids.filter(
      (targetId) => targetsById.get(targetId)?.enabled === false,
    );
    if (disabledTargetIds.length > 0) {
      warnings.push({
        group_id: group.id,
        group_index: groupIndex,
        code: "disabled_member",
        related_group_ids: [],
        related_target_ids: disabledTargetIds,
      });
    }
    if (!group.enabled) {
      continue;
    }
    const relatedGroupIds = pair.load_balancers
      .slice(groupIndex + 1)
      .filter(
        (other) =>
          other.enabled && modelPatternsMayOverlap(group.model_pattern, other.model_pattern),
      )
      .map((other) => other.id);
    if (relatedGroupIds.length > 0) {
      warnings.push({
        group_id: group.id,
        group_index: groupIndex,
        code: "overlapping_pattern",
        related_group_ids: relatedGroupIds,
        related_target_ids: [],
      });
    }
  }
  return warnings;
}
