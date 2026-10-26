import type { PricingEndpointKind } from "../pricing/usage-normalizer.js";

/**
 * The activity ledger behind the binding projection. It is held inside `LoadBalancer`
 * and keyed by binding incarnation, never by the numeric binding id, so a late release
 * can only ever reach the ledger of the reservation that created it - never a binding
 * that later reused the number, and never the traffic database. Nothing stored here is
 * request text, an exact key or a user message: counts, timestamps, one body size and
 * normalized token totals.
 *
 * Lifecycle - which cleanup runs where:
 *
 * | event                                   | ledger behavior                                            |
 * | --------------------------------------- | ---------------------------------------------------------- |
 * | `plan()` establishes a reservation      | begin: `inFlight` +1, start time and request ring appended |
 * | reservation release after full response | end: `inFlight` -1, end time; entry dropped if binding gone |
 * | duplicate or late release               | entry absent or already at zero: nothing written, no negative |
 * | TTL / LRU / prune / group removal       | binding leaves the table; entry kept while something is in flight |
 * | `sweepBindingActivity()`                | drops entries whose binding is gone and whose count is zero |
 * | `clear()` (pair stop)                   | every entry dropped; late releases become no-ops           |
 */

/** How many request starts a binding remembers for "active over several turns" display. */
export const MAX_RECENT_REQUEST_STARTS = 16;

/** Where the latest cost estimate for one binding actually came from. */
export type BindingCostSource = "normalized_usage" | "request_bytes" | "none";

/**
 * The most recent finished usage signal. Token counts are present only when a protocol
 * normalization produced them; a missing usage leaves them absent rather than guessed,
 * and the cost signal falls back to the request body size or to nothing.
 */
export interface BindingUsageSignal {
  readonly observedAt: number;
  readonly costSource: BindingCostSource;
  readonly endpoint: PricingEndpointKind | undefined;
  readonly inputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
}

/** What a completed response tells the ledger about its usage. */
export type BindingUsageObservation =
  | {
      readonly status: "complete";
      readonly endpoint: PricingEndpointKind;
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
    }
  | { readonly status: "unavailable" };

/**
 * Internal carrier of the "a human moved this binding" protection. The manual migration
 * paths (TRI-07, TRI-08) are what will set and clear it; until then this is the only
 * place the flag lives, and the projection is the only way to see it.
 */
export interface BindingManualProtection {
  readonly setAt: number;
}

/** The read shape the projection hands out. Copies all the way down. */
export interface BindingActivity {
  readonly inFlight: number;
  readonly lastRequestStartedAt: number | undefined;
  readonly lastResponseEndedAt: number | undefined;
  readonly recentRequestStarts: readonly number[];
  readonly lastRequestBytes: number | undefined;
  readonly lastUsage: BindingUsageSignal | undefined;
  readonly manualProtection: BindingManualProtection | undefined;
}

interface BindingActivityRecord {
  inFlight: number;
  lastRequestStartedAt: number | undefined;
  lastResponseEndedAt: number | undefined;
  recentRequestStarts: number[];
  lastRequestBytes: number | undefined;
  lastUsage: BindingUsageSignal | undefined;
  manualProtection: BindingManualProtection | undefined;
}

function emptyRecord(): BindingActivityRecord {
  return {
    inFlight: 0,
    lastRequestStartedAt: undefined,
    lastResponseEndedAt: undefined,
    recentRequestStarts: [],
    lastRequestBytes: undefined,
    lastUsage: undefined,
    manualProtection: undefined,
  };
}

function toActivity(record: BindingActivityRecord): BindingActivity {
  return {
    inFlight: record.inFlight,
    lastRequestStartedAt: record.lastRequestStartedAt,
    lastResponseEndedAt: record.lastResponseEndedAt,
    recentRequestStarts: [...record.recentRequestStarts],
    lastRequestBytes: record.lastRequestBytes,
    lastUsage: record.lastUsage,
    manualProtection: record.manualProtection,
  };
}

export class BindingActivityLedger {
  readonly #records = new Map<number, BindingActivityRecord>();

  /** One reservation opened: count up and remember when the request entered handling. */
  begin(incarnation: number, now: number): void {
    const record = this.#records.get(incarnation) ?? emptyRecord();
    record.inFlight += 1;
    record.lastRequestStartedAt = now;
    record.recentRequestStarts.push(now);
    // One shift per push is enough: the ring was at most at its cap before the push.
    if (record.recentRequestStarts.length > MAX_RECENT_REQUEST_STARTS) {
      record.recentRequestStarts.shift();
    }
    this.#records.set(incarnation, record);
  }

  /**
   * One reservation closed. The count only ever goes down while something is actually
   * counted, so a duplicate or late release cannot push it negative, and a release whose
   * entry was already cleaned up writes nothing at all. Returns the remaining count, or
   * `undefined` when there was no entry to end - the caller uses that to drop ledgers of
   * bindings the table has given up on.
   */
  end(incarnation: number, now: number): number | undefined {
    const record = this.#records.get(incarnation);
    if (record === undefined) {
      return undefined;
    }
    if (record.inFlight > 0) {
      record.inFlight -= 1;
    }
    record.lastResponseEndedAt = now;
    return record.inFlight;
  }

  /** The body size of the latest request, the coarse signal used when usage is missing. */
  noteRequestBytes(incarnation: number, bytes: number): void {
    const record = this.#records.get(incarnation) ?? emptyRecord();
    record.lastRequestBytes = bytes;
    this.#records.set(incarnation, record);
  }

  /**
   * Backfill the latest usage. A complete normalization becomes the token signal; an
   * unavailable one keeps whatever coarse evidence exists - body size when it was recorded,
   * otherwise nothing - and never carries token counts.
   */
  recordUsage(incarnation: number, observation: BindingUsageObservation, now: number): void {
    const record = this.#records.get(incarnation) ?? emptyRecord();
    record.lastUsage =
      observation.status === "complete"
        ? {
            observedAt: now,
            costSource: "normalized_usage",
            endpoint: observation.endpoint,
            inputTokens: observation.inputTokens,
            cacheReadTokens: observation.cacheReadTokens,
          }
        : {
            observedAt: now,
            costSource: record.lastRequestBytes === undefined ? "none" : "request_bytes",
            endpoint: undefined,
            inputTokens: undefined,
            cacheReadTokens: undefined,
          };
    this.#records.set(incarnation, record);
  }

  /** Mark this binding as moved by a human, so a future automatic policy must spare it. */
  setManualProtection(incarnation: number, now: number): void {
    const record = this.#records.get(incarnation) ?? emptyRecord();
    record.manualProtection = { setAt: now };
    this.#records.set(incarnation, record);
  }

  /** Drop the protection flag; the rest of the history stays. */
  clearManualProtection(incarnation: number): void {
    const record = this.#records.get(incarnation);
    if (record === undefined) {
      return;
    }
    record.manualProtection = undefined;
  }

  /** A copy of what one incarnation carries, or the zero state when nothing does. */
  read(incarnation: number): BindingActivity {
    const record = this.#records.get(incarnation);
    return record === undefined ? toActivity(emptyRecord()) : toActivity(record);
  }

  /** Remove one entry outright. */
  drop(incarnation: number): void {
    this.#records.delete(incarnation);
  }

  /** Remove every entry the caller judges stale; returns how many went. */
  dropWhere(test: (incarnation: number, activity: BindingActivity) => boolean): number {
    let dropped = 0;
    for (const incarnation of [...this.#records.keys()]) {
      const record = this.#records.get(incarnation);
      if (record !== undefined && test(incarnation, toActivity(record))) {
        this.#records.delete(incarnation);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Pair stop: nothing survives, and later releases find no entry to end. */
  dropAll(): void {
    this.#records.clear();
  }
}
