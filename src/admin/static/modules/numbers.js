// LLM Proxy admin UI -- value coercion and number display shared by logs, detail, metrics and statistics.
// ES module: bundled into /static/app.js by the entry (../entry.js).

import { displayLanguageIsEnglish, displayLocaleTag } from "./display-locale.js";

/**
 * A field the wire may leave out, empty or non-numeric. Only a finite number survives.
 * @param {unknown} value
 * @returns {number | null}
 */
export function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

/**
 * A measured value that is worth computing on: zero, missing and non-numeric all mean
 * "no sample", so callers get `undefined` and can fall back with `??`.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * Compact form for the counters that are read at a glance: 万/亿 in Chinese,
 * SI compact notation in English.
 * @param {unknown} value
 * @returns {string}
 */
export function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (displayLanguageIsEnglish())
    return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
  return n.toLocaleString(displayLocaleTag());
}

/**
 * The same value without compaction, for the card that has room for the exact figure.
 * @param {unknown} value
 * @returns {string}
 */
export function fullNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(displayLocaleTag()) : String(value);
}

/**
 * Whole numbers only: a missing figure stays the em dash the table already shows.
 * @param {unknown} value
 * @returns {string}
 */
export function formatIntegerValue(value) {
  if (value === null || value === undefined || value === "—") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(displayLocaleTag()) : String(value);
}

// Human-readable total for the summary card: >= 1亿 / >= 1万 in Chinese,
// >= 1B / >= 1M in English, otherwise a plain comma-grouped number.
/**
 * @param {unknown} n
 * @returns {string}
 */
export function formatTokenCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (displayLanguageIsEnglish()) {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  } else {
    if (value >= 1e8) return `${(value / 1e8).toFixed(1).replace(/\.0$/, "")} 亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, "")} 万`;
  }
  return value.toLocaleString(displayLocaleTag());
}

/**
 * Exact nano-CNY as a decimal string, with the trailing zeros trimmed. Money stays in
 * nano units on the wire so no binary fraction is ever involved.
 * @param {unknown} value
 * @returns {string | null}
 */
export function pricingDecimalFromNano(value) {
  if (value === null || value === undefined || value === "") return null;
  const nano = BigInt(String(value));
  const integer = nano / 1_000_000_000n;
  const fraction = (nano % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

/**
 * Token/s throughput as it is quoted in the cards: thousands shrink to `k`, two-significant
 * digits above 100, one decimal below. A value that is not a number is not a sample, so it
 * reads the same as the missing one.
 * @param {unknown} value
 * @returns {string}
 */
export function formatTokensPerSecond(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

/**
 * A decode speed as the list row and the task summary card print it: no sample stays
 * empty, three digits and up lose the fraction, everything else keeps one decimal.
 * @param {unknown} value
 * @returns {string}
 */
export function formatDecodeSpeed(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}
