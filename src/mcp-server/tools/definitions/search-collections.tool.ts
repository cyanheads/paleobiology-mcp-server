/**
 * @fileoverview paleobiology_search_collections — fossil localities by area + interval.
 * Returns localities with their strata, lithology, depositional environment, and
 * co-occurring-taxa count — a find-then-drill-in index. Paged inline (limit/offset),
 * truncation disclosed. No canvas spill.
 * @module mcp-server/tools/definitions/search-collections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { CollectionFilter, EnvironmentFilter } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

const CollectionSchema = z
  .object({
    collection_no: z
      .number()
      .int()
      .describe(
        'PBDB collection (locality) id — scope paleobiology_search_occurrences to it for the fauna found here.',
      ),
    collection_name: z.string().optional().describe('Locality name, when recorded.'),
    lng: z
      .number()
      .optional()
      .describe('MODERN longitude of the locality (where the rock is today).'),
    lat: z
      .number()
      .optional()
      .describe('MODERN latitude of the locality (where the rock is today).'),
    early_interval: z
      .string()
      .optional()
      .describe('Named interval of the older age bound, e.g. "Late Maastrichtian".'),
    late_interval: z
      .string()
      .optional()
      .describe('Named interval of the younger bound — present when the age spans two intervals.'),
    max_ma: z.number().optional().describe('Older age bound in millions of years ago.'),
    min_ma: z.number().optional().describe('Younger age bound in millions of years ago.'),
    formation: z.string().optional().describe('Geologic formation, when recorded.'),
    geological_group: z.string().optional().describe('Geologic group, when recorded.'),
    member: z.string().optional().describe('Geologic member, when recorded.'),
    lithology: z.string().optional().describe('Primary lithology (rock type), when recorded.'),
    lithology_description: z
      .string()
      .optional()
      .describe('Free-text lithology description, when recorded.'),
    environment: z
      .string()
      .optional()
      .describe(
        'Depositional environment as PBDB recorded it (finer than the filter enum), when known.',
      ),
    cc: z.string().optional().describe('ISO 3166-1 alpha-2 country code, when known.'),
    state: z.string().optional().describe('State/province, when known.'),
    county: z.string().optional().describe('County, when known.'),
    n_occs: z
      .number()
      .optional()
      .describe('Number of fossil occurrences (co-occurring taxa) recorded at this locality.'),
    reference_no: z
      .number()
      .int()
      .optional()
      .describe('PBDB bibliographic reference id for provenance.'),
  })
  .describe('A fossil collection (locality) with its age, strata, lithology, and environment.');

export const searchCollectionsTool = tool('paleobiology_search_collections', {
  title: 'paleobiology-mcp-server: search fossil collections',
  description:
    'Find fossil collections (localities) by area and geologic time — "what has been dug up here, and ' +
    'from what rock." Each locality returns its location, age (named interval and Ma), formation and ' +
    'strata, lithology, depositional environment, and the count of co-occurring fossils. Filter by a ' +
    'clade-inclusive base_name, a named interval or max_ma/min_ma range, a lng/lat bounding box, a ' +
    'formation or lithology name, and/or an environment. Results page inline via limit/offset (the ' +
    'response discloses when more remain). Take a collection_no from a row and pass it — or the same ' +
    'bbox+interval — to paleobiology_search_occurrences to see the actual fauna found together.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: z
      .string()
      .optional()
      .describe(
        'Clade-inclusive taxon filter — localities yielding this taxon or its descendants, e.g. "Dinosauria".',
      ),
    interval: z
      .string()
      .optional()
      .describe(
        'Named geologic interval bounding the age, e.g. "Maastrichtian". Alternative to max_ma/min_ma.',
      ),
    max_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Older age bound in millions of years ago. When paired with min_ma it must be strictly greater — max_ma is the deeper-time end of the window.',
      ),
    min_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Younger age bound in millions of years ago. When paired with max_ma it must be strictly smaller — min_ma is the nearer-to-present end of the window.',
      ),
    lngmin: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Western edge of the bounding box, decimal degrees (−180…180). Longitude is a closed pair — supply lngmax with it or neither.',
      ),
    lngmax: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Eastern edge of the bounding box, decimal degrees (−180…180). Longitude is a closed pair — supply lngmin with it or neither.',
      ),
    latmin: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Southern edge of the bounding box, decimal degrees (−90…90). Valid on its own — a lone latitude edge filters as a half-plane.',
      ),
    latmax: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Northern edge of the bounding box, decimal degrees (−90…90). Valid on its own — a lone latitude edge filters as a half-plane.',
      ),
    formation: z
      .string()
      .optional()
      .describe('Geologic formation name to filter by, e.g. "Hell Creek".'),
    lithology: z
      .string()
      .optional()
      .describe('Lithology (rock type) to filter by, e.g. "sandstone".'),
    environment: z
      .enum(ENVIRONMENTS)
      .optional()
      .describe(
        'Depositional environment: "marine", "terrestrial", or "freshwater" (lacustrine + fluvial). Omit for all.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe('Maximum localities to return per page (1–500).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Number of localities to skip — page with limit by advancing offset.'),
  }),
  output: z.object({
    collections: z.array(CollectionSchema).describe('Matching localities for this page.'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Localities returned in this page (set when the page was not truncated).'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the page filled to the limit — advance offset for more.'),
    shown: z
      .number()
      .optional()
      .describe('Number of localities returned in this page (set when truncated).'),
    cap: z
      .number()
      .optional()
      .describe('The per-page limit that was applied (set when truncated).'),
    notice: z.string().optional().describe('Guidance when no locality matched the filters.'),
    attribution: z.string().describe('CC-BY data attribution for the Paleobiology Database.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Source' },
  },
  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The call carried only pagination fields — no taxon, time, place, formation, lithology, or environment filter.',
      recovery:
        'Provide at least one filter: base_name, an interval or max_ma/min_ma range, a lng/lat bounding box, a formation or lithology, or an environment — then retry.',
    },
    {
      reason: 'incomplete_bbox',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Exactly one of lngmin/lngmax was supplied — a longitude box needs both edges.',
      recovery:
        'Supply the other longitude edge (lngmin AND lngmax) or drop the one you sent. A lone latmin or latmax is fine on its own.',
    },
    {
      reason: 'inverted_ma_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'min_ma was greater than or equal to max_ma — the age window is inverted or empty.',
      recovery:
        'Ages count backwards from the present: set max_ma to the older bound and min_ma to the younger one, so min_ma is strictly less than max_ma (e.g. max_ma 100, min_ma 66).',
    },
  ],

  async handler(input, ctx) {
    if (!hasCollectionFilter(input)) {
      throw ctx.fail(
        'missing_filter',
        'paleobiology_search_collections needs at least one filter (taxon, geologic time, place, formation, lithology, or environment) — PBDB rejects an unfiltered collection query.',
        { ...ctx.recoveryFor('missing_filter') },
      );
    }
    if ((input.lngmin == null) !== (input.lngmax == null)) {
      throw ctx.fail(
        'incomplete_bbox',
        `A longitude box needs both edges — got ${input.lngmin != null ? 'lngmin' : 'lngmax'} alone.`,
        { ...ctx.recoveryFor('incomplete_bbox') },
      );
    }
    if (input.max_ma != null && input.min_ma != null && input.min_ma >= input.max_ma) {
      throw ctx.fail(
        'inverted_ma_range',
        `min_ma (${input.min_ma}) must be strictly less than max_ma (${input.max_ma}).`,
        { ...ctx.recoveryFor('inverted_ma_range') },
      );
    }

    const filter: CollectionFilter = { limit: input.limit, offset: input.offset };
    if (input.base_name) filter.baseName = input.base_name;
    if (input.interval) filter.interval = input.interval;
    if (input.max_ma != null) filter.maxMa = input.max_ma;
    if (input.min_ma != null) filter.minMa = input.min_ma;
    if (input.lngmin != null) filter.lngmin = input.lngmin;
    if (input.lngmax != null) filter.lngmax = input.lngmax;
    if (input.latmin != null) filter.latmin = input.latmin;
    if (input.latmax != null) filter.latmax = input.latmax;
    if (input.formation) filter.formation = input.formation;
    if (input.lithology) filter.lithology = input.lithology;
    if (input.environment) filter.environment = input.environment as EnvironmentFilter;

    const result = await getPbdbService().searchCollections(filter, ctx);
    ctx.enrich({ attribution: PBDB_ATTRIBUTION });
    ctx.log.info('Collection search', { shown: result.shown, truncated: result.truncated });

    if (result.shown === 0) {
      ctx.enrich.total(0);
      ctx.enrich.notice(
        'No localities matched the filters. Widen the interval or bounding box, or relax the formation/' +
          'lithology/environment filter.',
      );
    } else if (result.truncated) {
      ctx.enrich.truncated({
        shown: result.shown,
        cap: result.cap,
        guidance: `Showing ${result.shown} localities (the page limit). Advance offset by ${result.cap} for the next page.`,
      });
    } else {
      ctx.enrich.total(result.shown);
    }

    return { collections: result.collections };
  },

  format: (result) => {
    if (result.collections.length === 0) {
      return [{ type: 'text', text: 'No fossil collections matched the filters.' }];
    }
    const lines: string[] = [`**${result.collections.length} locality(ies)**`, ''];
    for (const c of result.collections) {
      lines.push(`### ${c.collection_name ?? `collection #${c.collection_no}`}`);
      lines.push(
        `**collection_no:** ${c.collection_no}${c.n_occs != null ? ` | **occurrences:** ${c.n_occs}` : ''}`,
      );
      const interval = c.late_interval
        ? `${c.early_interval} – ${c.late_interval}`
        : (c.early_interval ?? '');
      const ma =
        c.max_ma != null && c.min_ma != null ? `${c.max_ma}–${c.min_ma} Ma` : 'age unknown';
      lines.push(`**age:** ${interval ? `${interval} (${ma})` : ma}`);
      const strata = [
        c.formation && `formation ${c.formation}`,
        c.geological_group && `group ${c.geological_group}`,
        c.member && `member ${c.member}`,
      ]
        .filter(Boolean)
        .join(', ');
      if (strata) lines.push(`**strata:** ${strata}`);
      if (c.lithology)
        lines.push(
          `**lithology:** ${c.lithology}${c.lithology_description ? ` — ${c.lithology_description}` : ''}`,
        );
      if (c.environment) lines.push(`**environment:** ${c.environment}`);
      lines.push(
        `**modern coords:** ${c.lng != null && c.lat != null ? `${c.lat}, ${c.lng}` : 'unknown'}`,
      );
      const place = [c.county, c.state, c.cc].filter(Boolean).join(', ');
      if (place) lines.push(`**locality:** ${place}`);
      if (c.reference_no != null) lines.push(`**reference_no:** ${c.reference_no}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});

/** True when the call carries at least one real search selector (not just pagination). */
function hasCollectionFilter(input: {
  base_name?: string | undefined;
  interval?: string | undefined;
  max_ma?: number | undefined;
  min_ma?: number | undefined;
  lngmin?: number | undefined;
  lngmax?: number | undefined;
  latmin?: number | undefined;
  latmax?: number | undefined;
  formation?: string | undefined;
  lithology?: string | undefined;
  environment?: string | undefined;
}): boolean {
  return (
    input.base_name != null ||
    input.interval != null ||
    input.max_ma != null ||
    input.min_ma != null ||
    input.lngmin != null ||
    input.lngmax != null ||
    input.latmin != null ||
    input.latmax != null ||
    input.formation != null ||
    input.lithology != null ||
    input.environment != null
  );
}
