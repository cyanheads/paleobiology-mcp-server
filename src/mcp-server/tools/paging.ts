/**
 * @fileoverview Paging constants, the environment enum, and the paging-notice
 * sentences shared by the list searches that page inline:
 * paleobiology_search_occurrences and paleobiology_search_collections.
 * @module mcp-server/tools/paging
 */

/** Depositional-environment filter values; `freshwater` expands to lacustrine + fluvial upstream. */
export const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

/** Most rows one call pulls; a larger `limit` is served at this cap, which the paging notice names. */
export const MAX_PAGE = 500;

/** Ceiling on the `limit` input — a guard against absurd values, well above {@link MAX_PAGE}. */
export const LIMIT_CEILING = 10_000;

/** Notice sentence for a page the inline budget cut short of the rows PBDB returned. */
export function cutPageNotice(shown: number, pulled: number): string {
  return `This page was cut to ${shown} of the ${pulled} pulled to fit the inline response size.`;
}

/** Notice sentence for a `limit` above {@link MAX_PAGE}; `noun` names the rows ("occurrences", "localities"). */
export function overCapNotice(limit: number, noun: string): string {
  return `limit ${limit} is above the per-call cap of ${MAX_PAGE}, so this page drew from at most ${MAX_PAGE} ${noun}.`;
}
