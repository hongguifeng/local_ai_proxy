/**
 * The vocabulary shared by every persistence access module.
 *
 * This module changes when the shape of a page or the reading of an unmodelled
 * cell changes — not when a task, a record, the search index or the pricing
 * aggregation changes. It holds no SQL and imports nothing, so any access module
 * can depend on it without pulling another data area in.
 */

/** A row the persistence layer has not projected: every cell is unmodelled. */
export type RepositoryRecord = Record<string, unknown>;

/** One page of a listing, with the offset the next page starts at. */
export interface RepositoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly hasMore: boolean;
}

/** Builds one page from rows the caller already fetched. */
export function repositoryPage<T>(
  items: readonly T[],
  total: number,
  limit: number,
  offset: number,
): RepositoryPage<T> {
  const nextOffset = offset + items.length;
  return {
    items,
    total,
    limit,
    offset,
    nextOffset,
    hasMore: nextOffset < total,
  };
}

/**
 * Returns the first non-null cell of `row` as text, or `fallback` when every
 * listed key is null, undefined, or not a primitive value.
 */
export function recordText(row: RepositoryRecord, fallback: string, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      return String(value);
  }
  return fallback;
}
