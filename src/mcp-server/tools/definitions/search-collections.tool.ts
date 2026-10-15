/**
 * @fileoverview paleobiology_search_collections — fossil localities by area + interval.
 * Returns localities with their strata, lithology, depositional environment, and
 * co-occurring-taxa count — a find-then-drill-in index. Paged inline (limit/offset),
 * truncation disclosed. No canvas spill.
 * @module mcp-server/tools/definitions/search-collections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/blank-as-unset.js';
import {
  ENVELOPE_RESERVE_BYTES,
  fitRows,
  jsonItemBytes,
  type SurfaceCost,
  utf8Bytes,
} from '@/mcp-server/tools/inline-budget.js';
import { oneLine } from '@/mcp-server/tools/one-line.js';
import {
  cutPageNotice,
  ENVIRONMENTS,
  LIMIT_CEILING,
  MAX_PAGE,
  overCapNotice,
} from '@/mcp-server/tools/paging.js';
import { emitNotice, ignoredFilterNotice, joinNotices } from '@/mcp-server/tools/pbdb-notices.js';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { Collection, CollectionFilter, EnvironmentFilter } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

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
      .describe(
        'PBDB bibliographic reference id — the publication this collection was entered from. Resolve it to a full citation with paleobiology_get_references.',
      ),
  })
  .describe('A fossil collection (locality) with its age, strata, lithology, and environment.');

export const searchCollectionsTool = tool('paleobiology_search_collections', {
  title: 'paleobiology-mcp-server: search fossil collections',
  description:
    'Find fossil collections (localities) by area and geologic time — "what has been dug up here, and from what rock." Each locality returns its location, age (named interval and Ma), formation and strata, lithology, depositional environment, and the count of co-occurring fossils. Filter by a clade-inclusive base_name (or base_id, the same clade by resolved taxon id), a named interval or max_ma/min_ma range, a lng/lat bounding box, a formation or lithology name, and/or an environment. Results page inline via limit/offset (the response discloses when more remain). Take a collection_no from a row and pass it — or the same bbox+interval — to paleobiology_search_occurrences to see the actual fauna found together.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: blankAsUnset(z.string().optional()).describe(
      'Clade-inclusive taxon filter — localities yielding this taxon or its descendants, e.g. "Dinosauria". Supply this or base_id, never both.',
    ),
    base_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Clade-inclusive taxon filter by PBDB taxon id — the taxon_no from paleobiology_get_taxon, or accepted_no on an occurrence row. Same semantics as base_name, but unambiguous where a name is not (homonyms, synonyms, unresolved spellings). Supply this or base_name, never both.',
      ),
    interval: blankAsUnset(z.string().optional()).describe(
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
    formation: blankAsUnset(z.string().optional()).describe(
      'Geologic formation name to filter by, e.g. "Hell Creek".',
    ),
    lithology: blankAsUnset(z.string().optional()).describe(
      'Lithology (rock type) to filter by, e.g. "sandstone".',
    ),
    environment: blankAsUnset(z.enum(ENVIRONMENTS).optional()).describe(
      'Depositional environment: "marine", "terrestrial", or "freshwater" (lacustrine + fluvial). Omit for all.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .default(100)
      .describe(
        `Maximum localities to return per page. Up to ${MAX_PAGE} are pulled per call; a larger value is served at ${MAX_PAGE}, and the paging notice names that cap when more matches remain. A page can show fewer rows than it pulled when more would exceed the inline response size — the notice then names the offset that continues.`,
      ),
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
      .describe('Total localities matching the filters upstream, across all pages.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when localities remain past this page — advance offset for more.'),
    shown: z
      .number()
      .optional()
      .describe('Number of localities returned in this page (set when truncated).'),
    cap: z
      .number()
      .optional()
      .describe('The per-page limit that was applied (set when truncated).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no locality matched, when localities remain past this page or it was cut to fit the inline response size (naming the offset that reaches the next one), when offset ran past the end of the match set, or when a filter value was not recognized and ignored.',
      ),
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
        'Provide at least one filter: base_name or base_id, an interval or max_ma/min_ma range, a lng/lat bounding box, a formation or lithology, or an environment — then retry.',
    },
    {
      reason: 'conflicting_taxon_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both base_name and base_id were supplied — PBDB accepts only one clade selector.',
      recovery:
        'Send base_id alone when the taxon id is already resolved, or base_name alone when working from a name — drop the other and retry.',
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
    {
      reason: 'pbdb_invalid_parameter',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'PBDB refused a filter value it could not use, such as an unknown interval or lithology name — the message quotes its reason.',
      recovery:
        'Correct the value PBDB named in the message — confirm an interval name with paleobiology_list_intervals or a taxon name with paleobiology_get_taxon, and check a formation or lithology spelling — or replace that filter with another one (a max_ma/min_ma range for an interval, base_id for a taxon), then retry.',
    },
  ],

  async handler(input, ctx) {
    if (!hasCollectionFilter(input)) {
      throw ctx.fail(
        'missing_filter',
        'paleobiology_search_collections needs at least one filter (taxon, geologic time, place, formation, lithology, or environment) — PBDB rejects an unfiltered collection query.',
      );
    }
    if (input.base_name != null && input.base_id != null) {
      throw ctx.fail(
        'conflicting_taxon_filter',
        `Got base_name "${input.base_name}" and base_id ${input.base_id} — PBDB accepts only one clade selector.`,
        { ...ctx.recoveryFor('conflicting_taxon_filter') },
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

    const filter: CollectionFilter = {
      limit: Math.min(input.limit, MAX_PAGE),
      offset: input.offset,
    };
    if (input.base_name) filter.baseName = input.base_name;
    if (input.base_id != null) filter.baseId = input.base_id;
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
    ctx.log.info('Collection search', {
      shown: result.shown,
      total: result.total,
      truncated: result.truncated,
      warnings: result.warnings?.length ?? 0,
    });

    const total = result.total ?? result.shown;
    ctx.enrich.total(total);

    // PBDB drops a filter value it does not recognize and answers 200 with the
    // rest of the query applied — for `lithology` that is the FULL unfiltered set.
    // Disclose it or the agent reads an unfiltered result as a match.
    const ignored = ignoredFilterNotice(result.warnings);
    const shown = fitRows(
      result.collections,
      COLLECTION_SURFACES,
      ENVELOPE_RESERVE_BYTES + utf8Bytes(ignored ?? ''),
    );
    const collections = result.collections.slice(0, shown);

    if (result.shown === 0) {
      // An empty page past the end of a non-empty match set is a paging mistake,
      // not a too-narrow filter — saying "widen the filters" would send the agent
      // to fix something that was never wrong.
      const pagedPastEnd = total > 0 && result.offset >= total;
      emitNotice(
        ctx,
        ignored,
        pagedPastEnd
          ? `Offset ${result.offset} is past the end of the ${total} matching localities. ` +
              `Lower offset to below ${total} — the filters themselves matched.`
          : 'No localities matched the filters. Widen the interval or bounding box, or relax the formation/' +
              'lithology/environment filter.',
      );
    } else if (result.truncated || shown < result.shown) {
      // Page numbers come off the same offset the service derived `truncated` from;
      // the next offset counts the rows this page delivers after the budget cut.
      const first = result.offset + 1;
      const last = result.offset + shown;
      ctx.enrich.truncated({
        shown,
        cap: result.cap,
        guidance: joinNotices(
          ignored,
          `Showing localities ${first}–${last} of ${total}.`,
          shown < result.shown ? cutPageNotice(shown, result.shown) : undefined,
          `Advance offset to ${last} for the next page.`,
          input.limit > MAX_PAGE ? overCapNotice(input.limit, 'localities') : undefined,
        ),
      });
    } else {
      emitNotice(ctx, ignored);
    }

    return { collections };
  },

  format: (result) => {
    // An empty page renders as a neutral count: whether the offset ran past the
    // end or nothing matched is the notice's call, never this header's.
    const header = `**${result.collections.length} locality(ies)**`;
    const text = [header, ...result.collections.map(renderCollection)].join(BLOCK_SEPARATOR);
    return [{ type: 'text', text: text.trim() }];
  },
});

/** The blank line between the header and each locality block in `format()`. */
const BLOCK_SEPARATOR = '\n\n';

/** One locality as its `format()` markdown block. */
function renderCollection(c: z.infer<typeof CollectionSchema>): string {
  const lines = [`### ${oneLine(c.collection_name ?? `collection #${c.collection_no}`)}`];
  lines.push(
    `**collection_no:** ${c.collection_no}${c.n_occs != null ? ` | **occurrences:** ${c.n_occs}` : ''}`,
  );
  const interval = oneLine(
    c.late_interval ? `${c.early_interval} – ${c.late_interval}` : (c.early_interval ?? ''),
  );
  const ma = c.max_ma != null && c.min_ma != null ? `${c.max_ma}–${c.min_ma} Ma` : 'age unknown';
  lines.push(`**age:** ${interval ? `${interval} (${ma})` : ma}`);
  const strata = [
    c.formation && `formation ${oneLine(c.formation)}`,
    c.geological_group && `group ${oneLine(c.geological_group)}`,
    c.member && `member ${oneLine(c.member)}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (strata) lines.push(`**strata:** ${strata}`);
  if (c.lithology)
    lines.push(
      `**lithology:** ${oneLine(c.lithology)}${c.lithology_description ? ` — ${oneLine(c.lithology_description)}` : ''}`,
    );
  if (c.environment) lines.push(`**environment:** ${oneLine(c.environment)}`);
  lines.push(
    `**modern coords:** ${c.lng != null && c.lat != null ? `${c.lat}, ${c.lng}` : 'unknown'}`,
  );
  const place = [c.county, c.state, c.cc]
    .filter((part): part is string => Boolean(part))
    .map(oneLine)
    .join(', ');
  if (place) lines.push(`**locality:** ${place}`);
  if (c.reference_no != null) lines.push(`**reference_no:** ${c.reference_no}`);
  return lines.join('\n');
}

/** What one locality costs on each client surface: a JSON array element, and its `format()` block. */
const COLLECTION_SURFACES: SurfaceCost<Collection>[] = [
  jsonItemBytes,
  (c) => utf8Bytes(renderCollection(c)) + BLOCK_SEPARATOR.length,
];

/** True when the call carries at least one real search selector (not just pagination). */
function hasCollectionFilter(input: {
  base_name?: string | undefined;
  base_id?: number | undefined;
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
    input.base_id != null ||
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
