/**
 * @fileoverview paleobiology_list_intervals — the geologic time scale lookup.
 * Translates named intervals ↔ absolute Ma boundaries. Browsing and every name
 * on the bundled ICS international-scale snapshot are answered offline; a name
 * the snapshot does not carry (PBDB's sub-stage and regional scales) costs one
 * upstream lookup, and the result names which source answered.
 * @module mcp-server/tools/definitions/list-intervals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  filterIntervals,
  getIntervalIndex,
  type IntervalFilters,
} from '@/services/intervals/interval-index.js';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { Interval } from '@/services/pbdb/types.js';

const LEVELS = ['eon', 'era', 'period', 'epoch', 'age'] as const;

/** Which source answered a lookup — the bundled snapshot, or a live PBDB call. */
const SOURCES = ['bundled_ics', 'pbdb_upstream'] as const;
type Source = (typeof SOURCES)[number];

const IntervalSchema = z
  .object({
    interval_no: z.number().int().describe('PBDB interval id for this geologic interval.'),
    name: z.string().describe('Interval name, e.g. "Maastrichtian" or "Late Maastrichtian".'),
    level: z
      .string()
      .describe(
        'Rank of the interval in its time scale. The international scale uses eon > era > ' +
          'period > epoch > age (finest); other PBDB scales also use subepoch, subage, zone, ' +
          'subzone, chron, subchron, and bin.',
      ),
    max_ma: z.number().describe('Older (bottom) boundary in millions of years ago.'),
    min_ma: z.number().describe('Younger (top) boundary in millions of years ago.'),
    parent_no: z
      .number()
      .int()
      .optional()
      .describe('PBDB id of the containing interval (epoch→period→era→eon). Omitted at the top.'),
    abbrev: z
      .string()
      .optional()
      .describe('Standard abbreviation (e.g. "K" for Cretaceous), when defined.'),
    color: z.string().optional().describe('ICS chart hex color for this interval, when defined.'),
    scale: z
      .string()
      .optional()
      .describe(
        'The PBDB time scale carrying this interval, e.g. "Mesozoic Subages" or "North ' +
          'American Land Mammal Ages". Present only on an interval resolved upstream — every ' +
          'bundled interval is on the international scale, which snapshot_version names.',
      ),
  })
  .describe('A geologic time interval with its rank, Ma boundaries, and parent.');

export const listIntervalsTool = tool('paleobiology_list_intervals', {
  title: 'paleobiology-mcp-server: list geologic intervals',
  description:
    'Look up the geologic time scale — eons, eras, periods, epochs, and ages with their ' +
    'absolute-age boundaries in millions of years (Ma) and nesting. This is the reference that ' +
    'grounds every temporal filter on the other tools and translates a named interval like ' +
    '"Late Cretaceous" to its 100.5–66.0 Ma boundaries (and back). Filter by a name substring, ' +
    'a Ma range (overlap match), and/or a level; call with no filters to browse the full scale. ' +
    'Browsing and every name on the bundled ICS international-scale snapshot are answered ' +
    'offline. A name the snapshot does not carry — the sub-stage and regional names that ' +
    'occurrence and collection rows report, such as "Late Maastrichtian" or "Lancian" — costs ' +
    'one PBDB lookup across its other time scales; the response names which source answered ' +
    'and which scale the interval belongs to.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring of the interval name, e.g. "cretaceous" or "Jurassic". ' +
          'A name the bundled international scale does not carry is matched exactly against ' +
          "PBDB's other time scales.",
      ),
    min_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Younger bound of an age window (Ma); intervals overlapping [min_ma, max_ma] match.',
      ),
    max_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe('Older bound of an age window (Ma); intervals overlapping [min_ma, max_ma] match.'),
    level: z
      .enum(LEVELS)
      .optional()
      .describe(
        'Restrict to one rank of the international scale: eon, era, period, epoch, or age ' +
          '(finest). Browsing is bounded to that scale, so the sub-stage and regional ranks ' +
          'are not selectable here.',
      ),
  }),
  output: z.object({
    intervals: z
      .array(IntervalSchema)
      .describe('Matching geologic intervals, sorted oldest-first.'),
    source: z
      .enum(SOURCES)
      .describe(
        'Which source answered: "bundled_ics" for the offline international-scale snapshot, ' +
          '"pbdb_upstream" for a name resolved live against PBDB\'s other time scales.',
      ),
    snapshot_version: z
      .string()
      .describe('ICS chart version and generation date of the bundled time scale, for citation.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Number of intervals matched by the filters.'),
    notice: z.string().optional().describe('Guidance when no interval matched the filters.'),
  },
  errors: [
    {
      reason: 'interval_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A named interval filter matched nothing — neither the bundled international scale (after any level or Ma filters) nor a PBDB lookup across its other time scales.',
      recovery:
        'Check the spelling, call paleobiology_list_intervals without a name to browse the international scale, or query by min_ma/max_ma instead.',
    },
    {
      reason: 'interval_lookup_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'The name is outside the bundled international scale and the PBDB lookup that covers the other time scales could not be reached.',
      recovery:
        'Retry in a moment; meanwhile any international-scale name still resolves offline, as does a min_ma/max_ma query.',
    },
  ],

  async handler(input, ctx) {
    const index = getIntervalIndex();
    const filters: IntervalFilters = {};
    if (input.name) filters.name = input.name;
    if (input.min_ma != null) filters.minMa = input.min_ma;
    if (input.max_ma != null) filters.maxMa = input.max_ma;
    if (input.level) filters.level = input.level;

    const hasFilters =
      input.name != null || input.min_ma != null || input.max_ma != null || input.level != null;
    let matches: Interval[] = hasFilters ? index.filter(filters) : index.all();
    let source: Source = 'bundled_ics';

    /*
     * The fallback fires on ONE condition: a name the bundled snapshot does not
     * carry AT ALL. An empty result for a name the snapshot knows means the
     * level/Ma filters excluded it — a bundled answer, and no reason to reach the
     * network — so that case is re-checked here rather than inferred from the
     * filtered count.
     */
    if (
      matches.length === 0 &&
      input.name != null &&
      index.filter({ name: input.name }).length === 0
    ) {
      let upstream: Interval | undefined;
      try {
        upstream = await getPbdbService().lookupInterval(input.name, ctx);
      } catch (err) {
        // Never let an unreachable PBDB read as "that interval does not exist" —
        // the agent gets a retry hint and keeps the offline scale.
        ctx.log.warning('Upstream interval lookup failed', {
          name: input.name,
          error: err instanceof Error ? err.message : String(err),
        });
        throw ctx.fail(
          'interval_lookup_unavailable',
          `"${input.name}" is not on the bundled international time scale, and the PBDB lookup covering the other scales could not be reached.`,
          { ...ctx.recoveryFor('interval_lookup_unavailable') },
        );
      }
      if (upstream) {
        // Re-apply the caller's filters: the upstream hit is one interval, and a
        // level or Ma window it falls outside still means "no match".
        matches = filterIntervals([upstream], filters);
        source = 'pbdb_upstream';
      }
    }

    ctx.enrich.total(matches.length);
    ctx.log.info('Interval lookup', { count: matches.length, source, filters: input });

    // A name filter that matches nothing is a genuine not-found (the agent asked
    // for a specific named interval). An empty Ma/level filter is just an empty list.
    if (matches.length === 0 && input.name != null) {
      throw ctx.fail('interval_not_found', `No interval matched name "${input.name}".`, {
        ...ctx.recoveryFor('interval_not_found'),
      });
    }
    if (matches.length === 0) {
      ctx.enrich.notice(
        'No interval matched the Ma/level filters. Widen the range or drop the level filter.',
      );
    }

    return {
      intervals: matches.map((iv) => ({ ...iv })),
      source,
      snapshot_version: index.snapshotVersion,
    };
  },

  format: (result) => {
    const lines = [
      `**Geologic intervals** (${result.snapshot_version}; source: ${result.source})`,
      '',
    ];
    for (const iv of result.intervals) {
      const parts = [`**${iv.name}** (${iv.level})`, `${iv.max_ma}–${iv.min_ma} Ma`];
      if (iv.abbrev) parts.push(`abbr ${iv.abbrev}`);
      parts.push(`int #${iv.interval_no}`);
      if (iv.parent_no != null) parts.push(`parent #${iv.parent_no}`);
      if (iv.scale) parts.push(`scale ${iv.scale}`);
      if (iv.color) parts.push(`color ${iv.color}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
