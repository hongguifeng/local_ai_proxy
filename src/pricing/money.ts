export const NANO_CNY_PER_CNY = 1_000_000_000n;
export const PRICE_MICROS_PER_CNY = 1_000_000n;
export const PRICE_UNITS_PER_CNY = 1_000_000_000_000n;
export const PRICE_TOKEN_PRODUCT_PER_CNY = 1_000_000_000_000_000_000n;
export const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

const pricePattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const effectivePricePattern = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u;

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

export interface PricingUnitPrice {
  readonly cache_read_per_million: string;
  readonly cache_write_per_million: string;
  readonly input_per_million: string;
  readonly output_per_million: string;
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

/** Converts a final yuan-per-million-token price to 10^-12 CNY units. */
export function pricePerMillionToUnits(value: string): bigint {
  if (!effectivePricePattern.test(value)) {
    throw new TypeError(
      "Price must be a non-negative decimal string with at most 12 decimal places.",
    );
  }
  const [integer, fraction = ""] = value.split(".");
  if (integer === undefined) {
    throw new TypeError("Price is missing its integer component.");
  }
  return BigInt(integer) * PRICE_UNITS_PER_CNY + BigInt(fraction.padEnd(12, "0"));
}

/** Multiplies a configured unit price by its multiplier without floating-point rounding. */
export function effectivePricePerMillion(price: string, multiplier: string | undefined): string {
  const priceMicros = pricePerMillionToMicros(price);
  const multiplierMicros = pricePerMillionToMicros(multiplier ?? "1");
  return decimalString(priceMicros * multiplierMicros, PRICE_UNITS_PER_CNY);
}

export function effectivePricingUnitPrice(
  price: PricingUnitPrice & { readonly price_multiplier?: string | undefined },
): PricingUnitPrice {
  return {
    input_per_million: effectivePricePerMillion(price.input_per_million, price.price_multiplier),
    output_per_million: effectivePricePerMillion(price.output_per_million, price.price_multiplier),
    cache_read_per_million: effectivePricePerMillion(
      price.cache_read_per_million,
      price.price_multiplier,
    ),
    cache_write_per_million: effectivePricePerMillion(
      price.cache_write_per_million,
      price.price_multiplier,
    ),
  };
}

/** Calculates one request cost, rounding only the final total to nanoyuan. */
export function calculateCost(
  usage: BillingTokenBuckets,
  price: PricingUnitPrice,
): CostCalculation {
  assertNonNegativeBuckets(usage);
  const breakdown: CostBreakdown = {
    inputUncachedProduct:
      usage.inputUncachedTokens * pricePerMillionToUnits(price.input_per_million),
    outputProduct: usage.outputTokens * pricePerMillionToUnits(price.output_per_million),
    cacheReadProduct: usage.cacheReadTokens * pricePerMillionToUnits(price.cache_read_per_million),
    cacheWriteProduct:
      usage.cacheWriteTokens * pricePerMillionToUnits(price.cache_write_per_million),
  };
  const totalProduct =
    breakdown.inputUncachedProduct +
    breakdown.outputProduct +
    breakdown.cacheReadProduct +
    breakdown.cacheWriteProduct;
  const costNanoCny = (totalProduct + 500_000_000n) / 1_000_000_000n;
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
