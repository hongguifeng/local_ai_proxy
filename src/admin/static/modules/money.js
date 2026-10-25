// LLM Proxy admin UI -- money display: exact decimal amounts, never a binary fraction.
// ES module: bundled into /static/app.js by the entry (../entry.js).

import { t } from "./core.js";
import { pricingDecimalFromNano } from "./numbers.js";

/**
 * A wire amount (a decimal string, or a nano-CNY integer through `pricingAmount`) as the
 * currency text the tables show. Amounts are decimal strings so the rounding below stays
 * exact; anything that is not a positive number keeps the em dash a missing value shows.
 * @param {unknown} amount
 * @returns {string}
 */
export function formatCurrencyAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const text = String(amount);
  const [wholeRaw, fractionRaw = ""] = text.split(".");
  const whole = wholeRaw || "0";
  const next = (fractionRaw.slice(0, 5) + "00000").slice(0, 5);
  let rounded = BigInt(whole + next.slice(0, 4)) + BigInt(next[4] >= "5" ? 1 : 0);
  const scale = 10_000n;
  const integer = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(4, "0").replace(/0+$/, "");
  if (integer === 0n && fraction === "" && !/^0+(?:\.0+)?$/.test(text))
    return `< ${t("currencySymbol")}0.0001`;
  return `${t("currencySymbol")}${integer}${fraction ? `.${fraction}` : ""}`;
}

/**
 * One record's own cost: pending and unpriced are states rather than amounts.
 * @param {{ status?: string, amount?: unknown } | null | undefined} cost
 * @returns {string}
 */
export function formatRequestCost(cost) {
  if (!cost || cost.status === "unpriced") return "—";
  if (cost.status === "pending") return t("calculating");
  return formatCurrencyAmount(cost.amount);
}

/**
 * Nano-CNY from the wire as currency text; used wherever the server answers in nanos.
 * @param {unknown} value
 * @returns {string}
 */
export function pricingAmount(value) {
  return formatCurrencyAmount(pricingDecimalFromNano(value));
}

/**
 * A task group's known cost. The list row and the task-detail summary card both print it,
 * so the "—" for a group with no priced request lives here as well.
 * @param {{ known_amount?: unknown } | null | undefined} cost
 * @returns {string}
 */
export function formatGroupCost(cost) {
  return cost ? formatCurrencyAmount(cost.known_amount) : "—";
}
