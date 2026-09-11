import type { ModelPrice } from "../config/index.js";
import { modelPatternMatches } from "../proxy/routing.js";

export interface ModelPriceMatch {
  readonly model: string;
  readonly rule: ModelPrice;
  readonly ruleIndex: number;
}

/** Exact patterns take precedence; wildcard patterns retain configured order. */
export function matchModelPrice(
  rules: readonly ModelPrice[],
  model: string,
): ModelPriceMatch | undefined {
  for (const [ruleIndex, rule] of rules.entries()) {
    if (!rule.model_pattern.includes("*") && rule.model_pattern === model) {
      return { model, rule, ruleIndex };
    }
  }
  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule.model_pattern.includes("*") && modelPatternMatches(rule.model_pattern, model)) {
      return { model, rule, ruleIndex };
    }
  }
  return undefined;
}
