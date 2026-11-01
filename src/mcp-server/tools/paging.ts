/**
 * @fileoverview Paging constants, the environment enum, and the paging-notice
 * sentences shared by the list searches that page inline:
 * paleobiology_search_occurrences and paleobiology_search_collections.
 * @module mcp-server/tools/paging
 */

/** Depositional-environment filter values; `freshwater` expands to lacustrine + fluvial upstream. */
export const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

/** Most rows one call pulls; a larger `limit` is served at this cap, which the paging notice names. */
export const MAX_PAGE = 10_000;

/** Ceiling on the `limit` input; configured page caps may be lower. */
export const LIMIT_CEILING = MAX_PAGE;

/** Notice sentence for a `limit` above {@link MAX_PAGE}; `noun` names the rows ("occurrences", "localities"). */
export function overCapNotice(limit: number, noun: string, cap = MAX_PAGE): string {
  return `limit ${limit} is above the per-call cap of ${cap}, so this page drew from at most ${cap} ${noun}.`;
}
