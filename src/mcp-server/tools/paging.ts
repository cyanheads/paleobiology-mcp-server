/**
 * @fileoverview Paging constants, the environment enum, and the paging-notice
 * sentences shared by the list searches that page inline:
 * paleobiology_search_occurrences and paleobiology_search_collections.
 * @module mcp-server/tools/paging
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { arePbdbClampLimitsEnabled, getServerConfig } from '@/config/server-config.js';

/** Depositional-environment filter values; `freshwater` expands to lacustrine + fluvial upstream. */
export const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

/** Most rows one call pulls; a larger `limit` is served at this cap, which the paging notice names. */
const MAX_PAGE = 10_000;

const PAGE_NOUNS = {
  paleobiology_search_collections: 'localities',
  paleobiology_search_occurrences: 'occurrences',
} as const;

type PagedTool = keyof typeof PAGE_NOUNS;

const clampedCalls = createCounter(
  'paleobiology.search.limit_clamped',
  'PBDB inline searches whose requested limit exceeded the effective page cap',
  '{call}',
);

/** Use the same limit schema for advertised and accepted arguments. */
export function searchLimitSchema(noun: (typeof PAGE_NOUNS)[PagedTool]) {
  const positiveInteger = z.number().int().min(1);
  const schema = arePbdbClampLimitsEnabled() ? positiveInteger : positiveInteger.max(MAX_PAGE);
  return schema
    .default(100)
    .describe(
      `Number of ${noun} requested for this page. The server serves at most ${MAX_PAGE} per call, and this deployment may serve fewer. The notice discloses the cap when applied. Pair with offset to page through matches.`,
    );
}

/** Resolve the inline limit once per valid tool call and disclose any clamp. */
export function resolveSearchLimit(tool: PagedTool, requested: number, ctx: Context) {
  const maximum = Math.min(MAX_PAGE, getServerConfig().pbdbMaxOccurrences);
  if (requested <= maximum) return { limit: requested, maximum };

  ctx.log.info('PBDB search limit clamped', { tool, requested, effective: maximum });
  clampedCalls.add(1, { tool });
  const notice = `limit ${requested} is above the per-call cap of ${maximum}, so this page drew from at most ${maximum} ${PAGE_NOUNS[tool]}.`;
  return { limit: maximum, maximum, notice };
}
