/**
 * @fileoverview paleobiology_list_intervals — the geologic time scale lookup.
 * Translates named intervals ↔ absolute Ma boundaries from a bundled ICS
 * snapshot; grounds every temporal filter the other tools accept. No upstream
 * call.
 * @module mcp-server/tools/definitions/list-intervals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getIntervalIndex } from '@/services/intervals/interval-index.js';
import type { Interval, IntervalLevel } from '@/services/pbdb/types.js';

const LEVELS = ['eon', 'era', 'period', 'epoch', 'age'] as const;

const IntervalSchema = z
  .object({
    interval_no: z.number().int().describe('PBDB interval id for this geologic interval.'),
    name: z.string().describe('Interval name, e.g. "Maastrichtian" or "Late Cretaceous".'),
    level: z
      .enum(LEVELS)
      .describe('Rank in the time scale: eon > era > period > epoch > age (finest).'),
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
    'Served from a bundled ICS international-scale snapshot, so it never hits the network.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring of the interval name, e.g. "cretaceous" or "Jurassic".',
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
      .describe('Restrict to one rank: eon, era, period, epoch, or age (finest).'),
  }),
  output: z.object({
    intervals: z
      .array(IntervalSchema)
      .describe('Matching geologic intervals, sorted oldest-first.'),
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
      when: 'A named interval filter matched nothing in the time-scale snapshot.',
      recovery:
        'Call paleobiology_list_intervals without a name to browse valid interval names, or query by min_ma/max_ma.',
    },
  ],

  handler(input, ctx) {
    const index = getIntervalIndex();
    const filters: { name?: string; minMa?: number; maxMa?: number; level?: IntervalLevel } = {};
    if (input.name) filters.name = input.name;
    if (input.min_ma != null) filters.minMa = input.min_ma;
    if (input.max_ma != null) filters.maxMa = input.max_ma;
    if (input.level) filters.level = input.level;

    const hasFilters =
      input.name != null || input.min_ma != null || input.max_ma != null || input.level != null;
    const matches: Interval[] = hasFilters ? index.filter(filters) : index.all();

    ctx.enrich.total(matches.length);
    ctx.log.info('Interval lookup', { count: matches.length, filters: input });

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
      snapshot_version: index.snapshotVersion,
    };
  },

  format: (result) => {
    const lines = [`**Geologic intervals** (${result.snapshot_version})`, ''];
    for (const iv of result.intervals) {
      const parts = [`**${iv.name}** (${iv.level})`, `${iv.max_ma}–${iv.min_ma} Ma`];
      if (iv.abbrev) parts.push(`abbr ${iv.abbrev}`);
      parts.push(`int #${iv.interval_no}`);
      if (iv.parent_no != null) parts.push(`parent #${iv.parent_no}`);
      if (iv.color) parts.push(`color ${iv.color}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
