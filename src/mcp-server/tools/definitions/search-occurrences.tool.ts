/**
 * @fileoverview paleobiology_search_occurrences — the flagship fossil-occurrence search.
 * Filters by taxon (clade-inclusive base_name or exact taxon_name), geologic
 * interval (named or Ma range), geographic bounding box, and depositional
 * environment. Surfaces modern AND paleo coordinates, both temporal
 * representations, and the higher classification on every row. Pages inline via
 * limit/offset against PBDB's true match count; large pages spill to a DataCanvas
 * for SQL.
 * @module mcp-server/tools/definitions/search-occurrences.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  ClassificationSchema,
  fmtClassification,
} from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { emitNotice, ignoredFilterNotice } from '@/mcp-server/tools/pbdb-notices.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { EnvironmentFilter, Occurrence, OccurrenceFilter } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

/** Upper bound on the per-call `limit`, quoted in the schema and the paging notices. */
const MAX_LIMIT = 500;

const OccurrenceSchema = z
  .object({
    occurrence_no: z
      .number()
      .int()
      .describe(
        'PBDB occurrence id — read the full record via the paleobiology://occurrence/{occurrence_no} resource.',
      ),
    collection_no: z
      .number()
      .int()
      .optional()
      .describe('Locality this came from — chain into paleobiology_search_collections.'),
    identified_name: z.string().optional().describe('The original field/published identification.'),
    identified_rank: z.string().optional().describe('Rank of the identified name.'),
    accepted_name: z
      .string()
      .optional()
      .describe('PBDB accepted name (may differ from the identification under synonymy).'),
    accepted_rank: z.string().optional().describe('Rank of the accepted name.'),
    accepted_no: z
      .number()
      .int()
      .optional()
      .describe('PBDB taxon id of the accepted name — chain into paleobiology_get_taxon.'),
    early_interval: z
      .string()
      .optional()
      .describe('Named geologic interval of the older age bound, e.g. "Late Maastrichtian".'),
    late_interval: z
      .string()
      .optional()
      .describe(
        'Named interval of the younger bound — present only when the age spans two intervals.',
      ),
    max_ma: z.number().optional().describe('Older age bound in millions of years ago.'),
    min_ma: z.number().optional().describe('Younger age bound in millions of years ago.'),
    lng: z
      .number()
      .optional()
      .describe('MODERN longitude — where the rock sits today. Not where the organism lived.'),
    lat: z
      .number()
      .optional()
      .describe('MODERN latitude — where the rock sits today. Not where the organism lived.'),
    paleolng: z
      .number()
      .optional()
      .describe(
        'PALEO longitude — where the landmass sat at deposition. Omitted when PBDB has no reconstruction.',
      ),
    paleolat: z
      .number()
      .optional()
      .describe(
        'PALEO latitude — where the landmass sat at deposition. Omitted when PBDB has no reconstruction.',
      ),
    paleomodel: z
      .string()
      .optional()
      .describe(
        'Plate-tectonic model used for the paleo-coordinates (e.g. "gplates"). They are model-dependent.',
      ),
    geoplate: z
      .string()
      .optional()
      .describe('Tectonic plate id under the paleo-model, when reported.'),
    formation: z.string().optional().describe('Geologic formation, when recorded.'),
    geological_group: z.string().optional().describe('Geologic group, when recorded.'),
    member: z.string().optional().describe('Geologic member, when recorded.'),
    cc: z
      .string()
      .optional()
      .describe('ISO 3166-1 alpha-2 country code of the modern locality, when known.'),
    state: z.string().optional().describe('State/province of the modern locality, when known.'),
    county: z.string().optional().describe('County of the modern locality, when known.'),
    classification: ClassificationSchema.optional().describe(
      'Higher classification of the accepted name (phylum → genus) — group rows by family or order without a per-row paleobiology_get_taxon call. Each level is present only when PBDB resolves it; omitted entirely when PBDB resolves none.',
    ),
    reference_no: z
      .number()
      .int()
      .optional()
      .describe('PBDB bibliographic reference id for provenance.'),
  })
  .describe(
    'A single fossil occurrence with modern and paleo coordinates, age, strata, and classification.',
  );

const SearchOccurrencesOutputSchema = z.object({
  occurrences: z
    .array(OccurrenceSchema)
    .describe(
      'Inline preview of matching occurrences for the requested page. The staged occurrence set is on the canvas when spilled is true — it is one page of the match set rather than every match (the notice states which rows this page covers, how many matched upstream, and the offset that reaches the next page).',
    ),
  spilled: z
    .boolean()
    .describe(
      'True when the result exceeded the inline preview and the staged occurrence set was written to the canvas.',
    ),
  canvas_id: z
    .string()
    .optional()
    .describe(
      'Canvas id holding the staged occurrence set — pass to paleobiology_dataframe_query. Present only when spilled is true; a result that fit inline stages nothing, so there is no table to query.',
    ),
  table_name: z
    .string()
    .optional()
    .describe('Canvas table holding the staged occurrence set. Present only when spilled is true.'),
  row_count: z
    .number()
    .describe(
      'Rows staged on the canvas when spilled; otherwise the preview length. Capped at the per-call limit (PBDB_MAX_OCCURRENCES) — compare against the totalCount enrichment for how many matched upstream.',
    ),
});

/** Inferred output type — the loose shape (optionals carry `| undefined`) the format() helpers read. */
type OccurrenceRow = z.infer<typeof OccurrenceSchema>;

export const searchOccurrencesTool = tool('paleobiology_search_occurrences', {
  title: 'paleobiology-mcp-server: search fossil occurrences',
  description:
    'Search fossil occurrences filtered by taxon, geologic time, geography, and depositional ' +
    'environment — the flagship. Use base_name for a clade and all its descendants (what "Tyrannosaurus ' +
    'occurrences" usually means), base_id for that same clade by resolved taxon id, or taxon_name for ' +
    'an exact taxon. Bound the age by a named interval ' +
    '(e.g. "Maastrichtian") or a max_ma/min_ma range, and/or a lng/lat bounding box; scope to a single ' +
    'locality with collection_no (take it from a paleobiology_search_collections row). At least one ' +
    'filter is required — taxon, time, place, environment, or collection_no. Every row carries two ' +
    'distinct coordinate systems — modern lng/lat (where the rock is today) and paleo lng/lat (where the ' +
    'landmass sat at deposition) — plus the formation, age interval, and higher classification (phylum ' +
    'through genus); never plot a deep-time occurrence on a modern coastline. Resolve a name with ' +
    'paleobiology_get_taxon first if unsure. Broad queries return many rows: an inline preview answers the ' +
    'immediate question, and when the set outgrows that preview the matching occurrences — up to the ' +
    'per-call cap — stage on a DataCanvas (canvas_id + table_name, returned only then) for SQL via ' +
    'paleobiology_dataframe_query (count by interval, group by formation/country, map by region). The ' +
    'response reports how many occurrences matched in total, which rows this page covers, and the ' +
    'offset that reaches the next page — page through the whole match set with limit/offset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: z
      .string()
      .optional()
      .describe(
        'Clade-inclusive taxon filter — this taxon and all descendants, e.g. "Dinosauria". The usual choice. Supply this or base_id, never both.',
      ),
    base_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Clade-inclusive taxon filter by PBDB taxon id — the taxon_no from paleobiology_get_taxon, or accepted_no on an occurrence row. Same clade-inclusive semantics as base_name, but unambiguous where a name is not (homonyms, synonyms, unresolved spellings). Supply this or base_name, never both.',
      ),
    taxon_name: z
      .string()
      .optional()
      .describe(
        'Exact taxon filter — only this taxon, not descendants. Use instead of base_name when you want a single taxon.',
      ),
    collection_no: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to one collection (locality) by its PBDB collection_no — the fauna found together at that site. Take the id from a paleobiology_search_collections row to drill from a locality into its occurrences.',
      ),
    interval: z
      .string()
      .optional()
      .describe(
        'Named geologic interval bounding the age, e.g. "Cretaceous" or "Maastrichtian". Alternative to max_ma/min_ma.',
      ),
    max_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Older age bound in millions of years ago. Alternative to interval. When paired with min_ma it must be strictly greater — max_ma is the deeper-time end of the window.',
      ),
    min_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Younger age bound in millions of years ago. Alternative to interval. When paired with max_ma it must be strictly smaller — min_ma is the nearer-to-present end of the window.',
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
      .max(MAX_LIMIT)
      .default(100)
      .describe(
        `Maximum occurrences to pull per page (1–${MAX_LIMIT}). Caps the pull (further bounded by PBDB_MAX_OCCURRENCES); broad queries stage that page on the canvas for SQL. Pair with offset to walk the whole match set.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching occurrences to skip before this page — page with limit by advancing offset. The response notice names the exact offset that reaches the next page.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas id from a prior call to re-stage onto the same workspace. Reusing it REPLACES (overwrites) the prior occurrence table — each search restages the full result, it does not append to or accumulate across earlier ones. Omit to start fresh; the response returns a new id.',
    ),
  }),
  output: SearchOccurrencesOutputSchema,
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total occurrences matching the filters upstream — the number this call was drawn from, which may exceed the staged set.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no occurrence matched, when results spilled to the canvas, when occurrences remain past this page (naming the offset that reaches the next one), when offset ran past the end of the match set, when a filter value was not recognized and ignored, or when DataCanvas is off.',
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
      when: 'The call carried only pagination fields — no taxon, time, place, environment, or collection filter.',
      recovery:
        'Provide at least one filter: base_name, base_id, or taxon_name, an interval or max_ma/min_ma range, a lng/lat bounding box, an environment, or a collection_no — then retry.',
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
  ],

  async handler(input, ctx) {
    if (!hasOccurrenceFilter(input)) {
      throw ctx.fail(
        'missing_filter',
        'paleobiology_search_occurrences needs at least one filter (taxon, geologic time, place, environment, or collection_no) — PBDB rejects an unfiltered occurrence query.',
        { ...ctx.recoveryFor('missing_filter') },
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

    const filter: OccurrenceFilter = { limit: input.limit, offset: input.offset };
    if (input.base_name) filter.baseName = input.base_name;
    if (input.base_id != null) filter.baseId = input.base_id;
    if (input.taxon_name) filter.taxonName = input.taxon_name;
    if (input.collection_no != null) filter.collectionNo = input.collection_no;
    if (input.interval) filter.interval = input.interval;
    if (input.max_ma != null) filter.maxMa = input.max_ma;
    if (input.min_ma != null) filter.minMa = input.min_ma;
    if (input.lngmin != null) filter.lngmin = input.lngmin;
    if (input.lngmax != null) filter.lngmax = input.lngmax;
    if (input.latmin != null) filter.latmin = input.latmin;
    if (input.latmax != null) filter.latmax = input.latmax;
    if (input.environment) filter.environment = input.environment as EnvironmentFilter;

    const service = getPbdbService();
    const canvas = getCanvas();

    // The service pulls at most `cap` rows (the smaller of the caller's limit and
    // the server-wide PBDB_MAX_OCCURRENCES). PBDB reports the true match count
    // (`records_found`) on the same envelope, so the notices below state the exact
    // remainder instead of guessing from a full page.
    const cap = Math.min(input.limit, getServerConfig().pbdbMaxOccurrences);

    ctx.enrich({ attribution: PBDB_ATTRIBUTION });

    // The row stream and its upstream metadata travel together: draining the
    // generator (here or inside spillover) discards its return value, so the true
    // total and PBDB's warnings are read off the handle once the drain completes.
    const search = service.searchOccurrences(filter, ctx);

    if (!canvas) {
      // DataCanvas disabled — drain the (capped) page inline; no usable canvas_id.
      const rows: Occurrence[] = [];
      for await (const row of search.rows) rows.push(row);
      const total = search.meta.recordsFound ?? rows.length;
      const ignored = ignoredFilterNotice(search.meta.warnings);
      ctx.enrich.total(total);
      if (rows.length === 0) {
        emitNotice(ctx, ignored, emptyPageNotice(input, total));
      } else {
        const page = nextPageNotice({
          offset: input.offset,
          shown: rows.length,
          total,
          limit: input.limit,
          cap,
        });
        emitNotice(
          ctx,
          ignored,
          page,
          page
            ? 'Enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) to stage a larger page for SQL in one call.'
            : undefined,
        );
      }
      ctx.log.info('Occurrence search (no canvas)', {
        count: rows.length,
        offset: input.offset,
        total,
      });
      return { occurrences: rows, spilled: false, row_count: rows.length };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    // The canvas id uses nanoid's URL-safe alphabet, which includes "-" — invalid
    // in an unquoted SQL identifier (the canvas rejects it). Map non-identifier
    // chars to "_" so the table name is always a legal identifier.
    const tableName = `occurrences_${instance.canvasId.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const result = await spillover({
      canvas: instance,
      source: search.rows,
      previewChars: 100_000, // ≈25k tokens inline
      tableName,
      signal: ctx.signal,
    });

    const previewRows = result.previewRows as Occurrence[];
    const stagedCount = result.spilled ? result.handle.rowCount : previewRows.length;
    const total = search.meta.recordsFound ?? stagedCount;
    ctx.enrich.total(total);
    const ignored = ignoredFilterNotice(search.meta.warnings);
    // Known, not inferred: PBDB's true match count anchors the page arithmetic.
    const page = nextPageNotice({
      offset: input.offset,
      shown: stagedCount,
      total,
      limit: input.limit,
      cap,
    });

    if (previewRows.length === 0) {
      emitNotice(ctx, ignored, emptyPageNotice(input, total));
    } else if (result.spilled) {
      emitNotice(
        ctx,
        ignored,
        `Staged ${stagedCount} matching occurrences on canvas ${instance.canvasId} as table ` +
          `"${result.handle.tableName}" — ${previewRows.length} rendered inline; query the staged set ` +
          'with paleobiology_dataframe_query (e.g. count by interval, group by formation).',
        page,
      );
    } else {
      // Everything fit inline; `page` is set only when matches remain past it.
      emitNotice(ctx, ignored, page);
    }
    ctx.log.info('Occurrence search', {
      preview: previewRows.length,
      spilled: result.spilled,
      offset: input.offset,
      total,
      canvas_id: instance.canvasId,
    });

    const out: z.infer<typeof SearchOccurrencesOutputSchema> = {
      occurrences: previewRows,
      spilled: result.spilled,
      row_count: stagedCount,
    };
    // canvas_id and table_name are gated together: nothing is staged unless the
    // result spilled, so returning the id on an inline result would point the
    // agent at an empty canvas.
    if (result.spilled) {
      out.canvas_id = instance.canvasId;
      out.table_name = result.handle.tableName;
    }
    return out;
  },

  format: (result) => {
    const header = result.spilled
      ? `**${result.row_count} occurrence(s)** staged on canvas \`${result.canvas_id ?? ''}\` as table \`${result.table_name ?? ''}\` (spilled: yes); preview below. See the notice for whether the per-call cap was hit.`
      : `**${result.occurrences.length} occurrence(s)** (spilled: no).`;
    if (result.occurrences.length === 0) {
      return [{ type: 'text', text: header }];
    }
    const lines: string[] = [header, ''];
    for (const o of result.occurrences) {
      const heading = o.accepted_name ?? o.identified_name ?? `occurrence #${o.occurrence_no}`;
      lines.push(`### ${heading}${o.accepted_rank ? ` (${o.accepted_rank})` : ''}`);
      const idLine = [`**occurrence_no:** ${o.occurrence_no}`];
      if (o.collection_no != null) idLine.push(`**collection_no:** ${o.collection_no}`);
      if (o.accepted_no != null) idLine.push(`**taxon_no:** ${o.accepted_no}`);
      lines.push(idLine.join(' | '));
      if (o.identified_name && o.identified_name !== o.accepted_name) {
        lines.push(
          `**identified as:** ${o.identified_name}${o.identified_rank ? ` (${o.identified_rank})` : ''}`,
        );
      }
      lines.push(`**age:** ${fmtAge(o)}`);
      lines.push(`**modern coords:** ${fmtCoords(o.lng, o.lat)}`);
      lines.push(`**paleo coords:** ${fmtPaleo(o)}${o.geoplate ? ` · plate ${o.geoplate}` : ''}`);
      const geo = [
        o.formation && `formation ${o.formation}`,
        o.geological_group && `group ${o.geological_group}`,
        o.member && `member ${o.member}`,
      ]
        .filter(Boolean)
        .join(', ');
      if (geo) lines.push(`**strata:** ${geo}`);
      const place = [o.county, o.state, o.cc].filter(Boolean).join(', ');
      if (place) lines.push(`**locality:** ${place}`);
      const cls = fmtClassification(o.classification);
      if (cls) lines.push(`**classification:** ${cls}`);
      if (o.reference_no != null) lines.push(`**reference_no:** ${o.reference_no}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});

/** The selector subset of the input read by the missing-filter guard and the empty notice. */
type OccurrenceFilterInput = {
  base_name?: string | undefined;
  base_id?: number | undefined;
  taxon_name?: string | undefined;
  collection_no?: number | undefined;
  interval?: string | undefined;
  max_ma?: number | undefined;
  min_ma?: number | undefined;
  lngmin?: number | undefined;
  lngmax?: number | undefined;
  latmin?: number | undefined;
  latmax?: number | undefined;
  environment?: string | undefined;
};

/** True when the call carries at least one real search selector (not just pagination). */
function hasOccurrenceFilter(input: OccurrenceFilterInput): boolean {
  return (
    input.base_name != null ||
    input.base_id != null ||
    input.taxon_name != null ||
    input.collection_no != null ||
    input.interval != null ||
    input.max_ma != null ||
    input.min_ma != null ||
    input.lngmin != null ||
    input.lngmax != null ||
    input.latmin != null ||
    input.latmax != null ||
    input.environment != null
  );
}

/**
 * Page-position guidance, or `undefined` when this page reached the end of the
 * match set. Advancing `offset` is the primary next step — "raise limit" only
 * appears when `limit` (not the server-wide cap) is what bounded the page and
 * there is headroom left, so it can never fire at the maximum.
 */
function nextPageNotice(page: {
  offset: number;
  shown: number;
  total: number;
  limit: number;
  cap: number;
}): string | undefined {
  const { offset, shown, total, limit, cap } = page;
  const last = offset + shown;
  if (shown === 0 || last >= total) return;
  const raisingLimitWouldHelp = cap === limit && limit < MAX_LIMIT;
  const raise = raisingLimitWouldHelp
    ? ` Or raise limit (max ${MAX_LIMIT}) to pull more per page.`
    : '';
  return (
    `Showing occurrences ${offset + 1}–${last} of ${total}. ` +
    `Advance offset to ${last} for the next page.${raise}`
  );
}

/**
 * The notice for a page that came back empty. Paging past the end of a non-empty
 * match set is a paging mistake, not a too-narrow filter — telling the agent to
 * widen its filters would send it to fix something that was never wrong.
 */
function emptyPageNotice(input: OccurrenceFilterInput & { offset: number }, total: number): string {
  if (total > 0 && input.offset >= total) {
    return (
      `Offset ${input.offset} is past the end of the ${total} matching occurrences. ` +
      `Lower offset to below ${total} — the filters themselves matched.`
    );
  }
  return emptyNotice(input);
}

/** Build an empty-result notice echoing the filters. */
function emptyNotice(input: OccurrenceFilterInput): string {
  const taxon =
    input.base_name ??
    input.taxon_name ??
    (input.base_id != null ? `taxon_no ${input.base_id}` : 'any taxon');
  const when =
    input.interval ??
    (input.max_ma != null ? `${input.max_ma}–${input.min_ma ?? 0} Ma` : 'all time');
  const where = input.collection_no != null ? ` in collection ${input.collection_no}` : '';
  const collTip =
    input.collection_no != null
      ? ' Confirm the collection_no with paleobiology_search_collections,'
      : '';
  return (
    `No occurrences matched ${taxon} in ${when}${where}.${collTip} Verify the taxon with ` +
    'paleobiology_get_taxon, widen the interval or bounding box, or drop the environment filter.'
  );
}

/** Render an occurrence's age, echoing interval(s) and Ma. */
function fmtAge(o: OccurrenceRow): string {
  const interval = o.late_interval
    ? `${o.early_interval} – ${o.late_interval}`
    : (o.early_interval ?? '');
  const ma = o.max_ma != null && o.min_ma != null ? `${o.max_ma}–${o.min_ma} Ma` : 'age unknown';
  return interval ? `${interval} (${ma})` : ma;
}

/** Render a modern coordinate pair, preserving unknowns. */
function fmtCoords(lng: number | undefined, lat: number | undefined): string {
  return lng != null && lat != null ? `${lat}, ${lng}` : 'unknown';
}

/** Render paleo-coordinates with the model name, preserving unknowns. */
function fmtPaleo(o: OccurrenceRow): string {
  if (o.paleolng == null || o.paleolat == null) return 'unknown (no reconstruction)';
  return `${o.paleolat}, ${o.paleolng}${o.paleomodel ? ` [${o.paleomodel}]` : ''}`;
}
