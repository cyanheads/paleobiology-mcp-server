/**
 * @fileoverview The inline response budget shared by the tools that return open-ended row
 * sets: paleobiology_search_occurrences, paleobiology_search_collections, and
 * paleobiology_dataframe_query.
 *
 * A row limit does not bound what a caller receives: the same 500 rows are
 * 30 KB of narrow aggregates or 300 KB of wide occurrence records. Each tool
 * therefore cuts its rows to the longest whole-row prefix whose cost fits this
 * budget on BOTH client surfaces — the `structuredContent` JSON and the
 * `content[]` text — so both carry the same rows. The budget is a constant, not
 * an env var: a deploy-tunable threshold would drift a tool's output shape
 * across environments. Callers name the remainder (the next offset, or the SQL
 * that continues a query) in their notice.
 * @module mcp-server/tools/inline-budget
 */

/** Per-surface ceiling on an inline response, in UTF-8 bytes (≈25k tokens). */
export const INLINE_BUDGET_BYTES = 100_000;

/**
 * Bytes held back from the row budget for the parts of a response that are not
 * rows: the JSON envelope, the `format()` header, and the enrichment fields and
 * trailer (notice, total, attribution). Upstream-quoted notice text varies in
 * size, so callers add its bytes on top.
 */
export const ENVELOPE_RESERVE_BYTES = 4_000;

/** The cost of one row on one client surface, in UTF-8 bytes. */
export type SurfaceCost<T> = (row: T) => number;

/** UTF-8 byte length of a string — what the caller receives, not UTF-16 units. */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Cost of a row as one element of a JSON array: its serialization plus the separator. */
export const jsonItemBytes = (row: unknown): number => utf8Bytes(JSON.stringify(row)) + 1;

/**
 * Length of the longest prefix of `rows` whose summed cost on every surface
 * stays within {@link INLINE_BUDGET_BYTES} less `reservedBytes`. Rows are
 * counted whole: the first row that would cross the budget on any surface ends
 * the prefix, so a row too large on its own yields 0.
 */
export function fitRows<T>(
  rows: readonly T[],
  surfaces: readonly SurfaceCost<T>[],
  reservedBytes = ENVELOPE_RESERVE_BYTES,
): number {
  const budget = INLINE_BUDGET_BYTES - reservedBytes;
  const tallies = surfaces.map((cost) => ({ cost, spent: 0 }));
  for (const [index, row] of rows.entries()) {
    for (const tally of tallies) {
      tally.spent += tally.cost(row);
      if (tally.spent > budget) return index;
    }
  }
  return rows.length;
}
