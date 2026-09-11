import type { ModelPrice } from "../config/index.js";

export const NANO_CNY_PER_CNY = 1_000_000_000n;
export const PRICE_MICROS_PER_CNY = 1_000_000n;
export const PRICE_TOKEN_PRODUCT_PER_CNY = 1_000_000_000_000n;
export const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

const pricePattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;

export interface BillingTokenBuckets {
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly inputUncachedTokens: bigint;
  readonly outputTokens: bigint;
}

export interface CostBreakdown {
  readonly cacheReadProduct: bigint;
  readonly cacheWriteProduct: bigint;
  readonly inputUncachedProduct: bigint;
  readonly outputProduct: bigint;
}

export interface CostCalculation {
  readonly breakdown: CostBreakdown;
  readonly costNanoCny: bigint;
  readonly totalProduct: bigint;
}

export class AmountOverflowError extends RangeError {
  readonly code = "amount_overflow";

  constructor() {
    super("The calculated cost exceeds the SQLite signed 64-bit integer range.");
    this.name = "AmountOverflowError";
  }
}

/** Converts a validated yuan-per-million-token price to integer price micros. */
export function pricePerMillionToMicros(value: string): bigint {
  if (!pricePattern.test(value)) {
    throw new TypeError(
      "Price must be a non-negative decimal string with at most 6 decimal places.",
    );
  }
  const [integer, fraction = ""] = value.split(".");
  if (integer === undefined) {
    throw new TypeError("Price is missing its integer component.");
  }
  return BigInt(integer) * PRICE_MICROS_PER_CNY + BigInt(fraction.padEnd(6, "0"));
}

/** Calculates one request cost, rounding only the final total to nanoyuan. */
export function calculateCost(
  usage: BillingTokenBuckets,
  price: Pick<
    ModelPrice,
    | "input_per_million"
    | "output_per_million"
    | "cache_read_per_million"
    | "cache_write_per_million"
  >,
): CostCalculation {
  assertNonNegativeBuckets(usage);
  const breakdown: CostBreakdown = {
    inputUncachedProduct:
      usage.inputUncachedTokens * pricePerMillionToMicros(price.input_per_million),
    outputProduct: usage.outputTokens * pricePerMillionToMicros(price.output_per_million),
    cacheReadProduct: usage.cacheReadTokens * pricePerMillionToMicros(price.cache_read_per_million),
    cacheWriteProduct:
      usage.cacheWriteTokens * pricePerMillionToMicros(price.cache_write_per_million),
  };
  const totalProduct =
    breakdown.inputUncachedProduct +
    breakdown.outputProduct +
    breakdown.cacheReadProduct +
    breakdown.cacheWriteProduct;
  const costNanoCny = (totalProduct + 500n) / 1_000n;
  if (costNanoCny > MAX_SQLITE_INTEGER) {
    throw new AmountOverflowError();
  }
  return { breakdown, costNanoCny, totalProduct };
}

/** Formats exact integer currency units without converting through Number. */
export function decimalString(value: bigint, unitsPerCny: bigint): string {
  if (value < 0n || unitsPerCny < 1n) {
    throw new RangeError("Decimal formatting requires non-negative values and a positive scale.");
  }
  const scale = unitsPerCny.toString().length - 1;
  if (10n ** BigInt(scale) !== unitsPerCny) {
    throw new RangeError("Decimal formatting requires a power-of-ten scale.");
  }
  const integer = value / unitsPerCny;
  const fraction = (value % unitsPerCny).toString().padStart(scale, "0").replace(/0+$/u, "");
  return fraction === "" ? integer.toString() : `${integer}.${fraction}`;
}

export function nanoCnyToDecimal(value: bigint): string {
  return decimalString(value, NANO_CNY_PER_CNY);
}

export function productToCnyDecimal(value: bigint): string {
  return decimalString(value, PRICE_TOKEN_PRODUCT_PER_CNY);
}

function assertNonNegativeBuckets(usage: BillingTokenBuckets): void {
  for (const value of Object.values(usage)) {
    if (value < 0n) {
      throw new RangeError("Token counts must be non-negative.");
    }
  }
}
