/**
 * @fileoverview paleobiology_search_occurrences — the flagship fossil-occurrence search.
 * Filters by taxon (clade-inclusive base_name or exact taxon_name), geologic
 * interval (named or Ma range), geographic bounding box, and depositional
 * environment. Surfaces modern AND paleo coordinates, both temporal
 * representations, and the higher classification on every row. Pages inline via
 * limit/offset against PBDB's true match count; with DataCanvas on, a page that
 * has additional matches stages a bounded matching set for SQL.
 * @module mcp-server/tools/definitions/search-occurrences.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type CanvasInstance,
  type ColumnType,
  type DataCanvas,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { blankAsUnset } from '@/mcp-server/tools/blank-as-unset.js';
import { CountryFilterSchema } from '@/mcp-server/tools/country-filter.js';
import {
  ClassificationSchema,
  fmtClassification,
} from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { oneLine } from '@/mcp-server/tools/one-line.js';
import { ENVIRONMENTS, LIMIT_CEILING, MAX_PAGE, overCapNotice } from '@/mcp-server/tools/paging.js';
import { emitNotice, ignoredFilterNotice } from '@/mcp-server/tools/pbdb-notices.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getPbdbService, MAX_STAGED_OCCURRENCES } from '@/services/pbdb/pbdb-service.js';
import type { Occurrence, OccurrenceFilter, OccurrenceSearch } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

/** Stable types preserve fractions and columns absent from the inline preview. */
const OCCURRENCE_COLUMN_TYPES = {
  occurrence_no: 'BIGINT',
  collection_no: 'BIGINT',
  identified_name: 'VARCHAR',
  identified_rank: 'VARCHAR',
  accepted_name: 'VARCHAR',
  accepted_rank: 'VARCHAR',
  accepted_no: 'BIGINT',
  early_interval: 'VARCHAR',
  late_interval: 'VARCHAR',
  max_ma: 'DOUBLE',
  min_ma: 'DOUBLE',
  lng: 'DOUBLE',
  lat: 'DOUBLE',
  paleolng: 'DOUBLE',
  paleolat: 'DOUBLE',
  paleomodel: 'VARCHAR',
  geoplate: 'VARCHAR',
  formation: 'VARCHAR',
  geological_group: 'VARCHAR',
  member: 'VARCHAR',
  cc: 'VARCHAR',
  state: 'VARCHAR',
  county: 'VARCHAR',
  classification: 'JSON',
  reference_no: 'BIGINT',
} satisfies Record<keyof Occurrence, ColumnType>;

const OCCURRENCE_CANVAS_SCHEMA = Object.entries(OCCURRENCE_COLUMN_TYPES).map(([name, type]) => ({
  name,
  type,
  nullable: name !== 'occurrence_no',
}));

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
      .describe(
        'PBDB bibliographic reference id — the publication this occurrence was entered from. Resolve it to a full citation with paleobiology_get_references.',
      ),
  })
  .describe(
    'A single fossil occurrence with modern and paleo coordinates, age, strata, and classification.',
  );

const SearchOccurrencesOutputSchema = z.object({
  occurrences: z
    .array(OccurrenceSchema)
    .describe(
      'Every occurrence in the requested page, subject to the configured page cap. When spilled is true, the canvas holds the bounded matching set independently of this page; the notice states whether staging covers every match.',
    ),
  spilled: z
    .boolean()
    .describe(
      'True when the first page had additional matches and the bounded matching set was written to the canvas.',
    ),
  canvas_id: z
    .string()
    .optional()
    .describe(
      'Canvas id holding the staged occurrence set — pass it to paleobiology_dataframe_describe for columns, then paleobiology_dataframe_query for SQL. Present only when spilled is true; complete pages and later offsets stage nothing.',
    ),
  table_name: z
    .string()
    .optional()
    .describe(
      'Canvas table holding the staged occurrence set — the FROM target in paleobiology_dataframe_query SQL, and the table paleobiology_dataframe_describe reports columns for. Present only when spilled is true.',
    ),
  row_count: z
    .number()
    .describe(
      'Rows staged on the canvas when spilled (at most 50,000); otherwise occurrences returned inline. Compare against totalCount for full-match coverage.',
    ),
});

/** Inferred output type — the loose shape (optionals carry `| undefined`) the format() helpers read. */
type OccurrenceRow = z.infer<typeof OccurrenceSchema>;

export const searchOccurrencesTool = tool('paleobiology_search_occurrences', {
  title: 'paleobiology-mcp-server: search fossil occurrences',
  description:
    'Search fossil occurrences by clade-inclusive base_name or base_id, exact taxon_name, interval or max_ma/min_ma, modern geographic bounds, country, formation, environment, or collection_no. At least one filter is required. Formation matches PBDB stored names and preserves list/wildcard syntax; suffixes are not removed. Resolve uncertain taxon names with paleobiology_get_taxon. Rows carry modern lng/lat, reconstructed paleolng/paleolat, age, strata, classification, and source reference_no; keep the coordinate systems distinct. Every served page row is returned, with total matches and the offset that continues the page. When this deployment has DataCanvas enabled, a first page with additional matches stages up to 50,000 occurrences on a canvas: use paleobiology_dataframe_describe for columns, then paleobiology_dataframe_query for SQL over the staged set; the notice distinguishes complete from partial coverage. Later offsets and complete pages stage nothing and leave any supplied canvas untouched.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: blankAsUnset(z.string().optional()).describe(
      'Clade-inclusive taxon filter — this taxon and all descendants, e.g. "Dinosauria". The usual choice. Supply this or base_id, never both.',
    ),
    base_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Clade-inclusive taxon filter by PBDB taxon id — the accepted_no from paleobiology_get_taxon or an occurrence row. Same clade-inclusive semantics as base_name, but unambiguous where a name is not (homonyms, synonyms, unresolved spellings). Supply this or base_name, never both.',
      ),
    taxon_name: blankAsUnset(z.string().optional()).describe(
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
    interval: blankAsUnset(z.string().optional()).describe(
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
    environment: blankAsUnset(z.enum(ENVIRONMENTS).optional()).describe(
      'Depositional environment: "marine", "terrestrial", or "freshwater" (lacustrine + fluvial). Omit for all.',
    ),
    formation: blankAsUnset(z.string().optional()).describe(
      'Stored formation name or PBDB list/wildcard expression, passed unchanged; suffixes such as Formation are not removed.',
    ),
    country: blankAsUnset(CountryFilterSchema.optional()).describe(
      'PBDB country/continent codes, comma-separated; ! excludes a list and ^ subtracts a code, e.g. NOA,^US.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .default(100)
      .describe(
        `Maximum occurrences to return per page, up to ${MAX_PAGE}, subject to PBDB_MAX_OCCURRENCES. Every fetched page row is returned; the notice discloses a lower configured cap. Pair with offset to walk the match set.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching occurrences to skip before this page — page with limit by advancing offset. The response notice names the exact offset that reaches the next page.',
      ),
    canvas_id: blankAsUnset(CanvasIdSchema.optional()).describe(
      'Canvas id from a prior call to restage onto the same workspace. Used only on a first page with matches beyond that page: replaces the prior occurrence table atomically with a bounded matching set, without appending. Later offsets and complete pages leave it untouched. Omit to start fresh.',
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
        'Applied filters and empty/past-end guidance, page continuation, ignored upstream filters, staged-set coverage, or optional staging unavailability.',
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
    {
      reason: 'pbdb_invalid_parameter',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'PBDB refused a filter value it could not use, such as an unknown interval name — the message quotes its reason.',
      recovery:
        'Correct the value PBDB named in the message — confirm an interval name with paleobiology_list_intervals or a taxon name with paleobiology_get_taxon — or replace that filter with another one (a max_ma/min_ma range for an interval, base_id for a taxon), then retry.',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'The first page has additional matches to stage and no canvas_id was passed, but every canvas slot open to this caller is already taken.',
      recovery:
        'Pass a canvas_id you already hold to replace its occurrence table, or narrow the matching set until it fits in the requested page.',
    },
  ],

  async handler(input, ctx) {
    if (!hasOccurrenceFilter(input)) {
      throw ctx.fail(
        'missing_filter',
        'paleobiology_search_occurrences needs at least one filter (taxon, geologic time, place, environment, or collection_no) — PBDB rejects an unfiltered occurrence query.',
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

    const filter: OccurrenceFilter = {
      limit: input.limit,
      offset: input.offset,
    };
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
    if (input.environment) filter.environment = input.environment;
    if (input.country) filter.country = input.country;
    if (input.formation) filter.formation = input.formation;

    // The service pulls at most `cap` rows (the smaller of the served page size and
    // the server-wide row cap). PBDB reports the true match count (`records_found`)
    // on the same envelope, so the notices below state the exact remainder instead
    // of guessing from a full page.
    const cap = Math.min(filter.limit, getServerConfig().pbdbMaxOccurrences);

    ctx.enrich({ attribution: PBDB_ATTRIBUTION });

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(55_000)]);
    const boundedCtx = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
      signal,
    }) as Context;
    const { rows, meta } = await getPbdbService().searchOccurrences(filter, boundedCtx);
    const total = meta.recordsFound ?? rows.length;
    ctx.enrich.total(total);
    const ignored = ignoredFilterNotice(meta.warnings);

    if (rows.length === 0) {
      emitNotice(ctx, ignored, emptyPageNotice(input, total));
      return { occurrences: [], spilled: false, row_count: 0 };
    }

    const shown = rows.length;
    const canvas = getCanvas();
    const pageArgs = { offset: input.offset, total, limit: input.limit, cap };

    if (!canvas || input.offset !== 0 || rows.length >= total) {
      // Later offsets, complete pages, and canvas-free deployments leave a supplied canvas untouched.
      const page = nextPageNotice({ ...pageArgs, shown });
      emitNotice(ctx, ignored, page);
      ctx.log.info('Occurrence search', {
        shown,
        pulled: rows.length,
        offset: input.offset,
        total,
      });
      return { occurrences: rows, spilled: false, row_count: shown };
    }

    // Acquired only now that the page is known to spill, so a call that stages
    // nothing holds no tenant canvas slot. The cap is reached only on a fresh mint;
    // the framework's generic hint points at a drop tool, but
    // paleobiology_dataframe_drop removes a table, never a canvas, so the refusal is
    // re-raised with the levers that work here.
    const instance = await canvas.acquire(input.canvas_id, boundedCtx).catch((err: unknown) => {
      if (err instanceof McpError && err.data?.reason === 'canvas_capacity_exhausted') {
        throw ctx.fail(
          'canvas_capacity_exhausted',
          'No canvas slot is free to stage the matching occurrences: the active canvas cap is reached.',
          undefined,
          { cause: err },
        );
      }
      throw err;
    });
    let set: OccurrenceSearch;
    try {
      set = await getPbdbService().searchOccurrenceSet(filter, boundedCtx);
    } catch (err) {
      await cleanupFreshCanvas(canvas, instance, ctx);
      ctx.signal.throwIfAborted();
      if (
        !signal.aborted &&
        (!(err instanceof McpError) ||
          ![
            JsonRpcErrorCode.ServiceUnavailable,
            JsonRpcErrorCode.Timeout,
            JsonRpcErrorCode.RateLimited,
          ].includes(err.code))
      )
        throw err;
      emitNotice(
        ctx,
        ignored,
        nextPageNotice({ ...pageArgs, shown }),
        'The matching set could not be acquired for SQL because PBDB is temporarily unavailable; this response still contains the requested page. Retry this first page to stage the set.',
      );
      return { occurrences: rows, spilled: false, row_count: rows.length };
    }
    const { tableName, stagedCount } = await stageOccurrences(
      canvas,
      instance,
      set.rows,
      boundedCtx,
    );
    const stagedTotal = set.meta.recordsFound;
    if (stagedTotal !== undefined) ctx.enrich.total(stagedTotal);
    emitNotice(
      ctx,
      ignored,
      `Staged ${stagedCount} matching occurrences on canvas ${instance.canvasId} as table ` +
        `"${tableName}" — ${shown} rendered inline; call paleobiology_dataframe_describe for ` +
        'the table and column names, then paleobiology_dataframe_query to analyze the full staged ' +
        'set with SQL (e.g. count by interval, group by formation).',
      // Inline paging retains the page request's snapshot and counts only its rows.
      ignoredFilterNotice(set.meta.warnings),
      stagedTotal === undefined
        ? `This table contains ${stagedCount} occurrences; PBDB did not report the staging total, so completeness is unknown.`
        : stagedCount < stagedTotal
          ? `This table contains ${stagedCount} of ${stagedTotal} matching occurrences, bounded at ${MAX_STAGED_OCCURRENCES}; it is a partial set. Narrow the filters for complete-set SQL.`
          : `The table contains all ${stagedCount} matching occurrences.`,
      nextPageNotice({ ...pageArgs, shown }),
    );
    ctx.log.info('Occurrence search', {
      preview: shown,
      staged: stagedCount,
      offset: input.offset,
      total,
      canvas_id: instance.canvasId,
    });
    return {
      occurrences: rows,
      spilled: true,
      canvas_id: instance.canvasId,
      table_name: tableName,
      row_count: stagedCount,
    };
  },

  format: (result) => {
    const header = result.spilled
      ? `**${result.row_count} occurrence(s)** staged on canvas \`${result.canvas_id ?? ''}\` as table \`${result.table_name ?? ''}\` (spilled: yes); preview below. The notice names the rows this page covers and the offset that reaches the next page.`
      : `**${result.occurrences.length} occurrence(s)** (spilled: no).`;
    if (result.occurrences.length === 0) {
      return [{ type: 'text', text: header }];
    }
    const text = [header, ...result.occurrences.map(renderOccurrence)].join(BLOCK_SEPARATOR);
    return [{ type: 'text', text: text.trim() }];
  },
});

/** The blank line between the header and each occurrence block in `format()`. */
const BLOCK_SEPARATOR = '\n\n';

/** One occurrence as its `format()` markdown block. */
function renderOccurrence(o: OccurrenceRow): string {
  const heading = o.accepted_name ?? o.identified_name ?? `occurrence #${o.occurrence_no}`;
  const lines = [
    `### ${oneLine(heading)}${o.accepted_rank ? ` (${oneLine(o.accepted_rank)})` : ''}`,
  ];
  const idLine = [`**occurrence_no:** ${o.occurrence_no}`];
  if (o.collection_no != null) idLine.push(`**collection_no:** ${o.collection_no}`);
  if (o.accepted_no != null) idLine.push(`**taxon_no:** ${o.accepted_no}`);
  lines.push(idLine.join(' | '));
  if (o.identified_name && o.identified_name !== o.accepted_name) {
    lines.push(
      `**identified as:** ${oneLine(o.identified_name)}${o.identified_rank ? ` (${oneLine(o.identified_rank)})` : ''}`,
    );
  }
  lines.push(`**age:** ${fmtAge(o)}`);
  lines.push(`**modern coords:** ${fmtCoords(o.lng, o.lat)}`);
  lines.push(
    `**paleo coords:** ${fmtPaleo(o)}${o.geoplate ? ` · plate ${oneLine(o.geoplate)}` : ''}`,
  );
  const geo = [
    o.formation && `formation ${oneLine(o.formation)}`,
    o.geological_group && `group ${oneLine(o.geological_group)}`,
    o.member && `member ${oneLine(o.member)}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (geo) lines.push(`**strata:** ${geo}`);
  const place = [o.county, o.state, o.cc]
    .filter((part): part is string => Boolean(part))
    .map(oneLine)
    .join(', ');
  if (place) lines.push(`**locality:** ${place}`);
  const cls = fmtClassification(o.classification);
  if (cls) lines.push(`**classification:** ${cls}`);
  if (o.reference_no != null) lines.push(`**reference_no:** ${o.reference_no}`);
  return lines.join('\n');
}

/**
 * Register the bounded matching set atomically. The provider rolls back a failed
 * replacement to the old table; only a canvas minted by this call needs cleanup.
 */
async function stageOccurrences(
  canvas: DataCanvas,
  instance: CanvasInstance,
  rows: Occurrence[],
  ctx: Context,
): Promise<{ tableName: string; stagedCount: number }> {
  // The canvas id uses nanoid's URL-safe alphabet, which includes "-" — invalid
  // in an unquoted SQL identifier (the canvas rejects it). Map non-identifier
  // chars to "_" so the table name is always a legal identifier.
  const tableName = `occurrences_${instance.canvasId.replace(/[^A-Za-z0-9_]/g, '_')}`;
  try {
    const handle = await instance.registerTable(tableName, rows, {
      schema: OCCURRENCE_CANVAS_SCHEMA,
      signal: ctx.signal,
    });
    return { tableName: handle.tableName, stagedCount: handle.rowCount };
  } catch (err) {
    await cleanupFreshCanvas(canvas, instance, ctx);
    throw err;
  }
}

/** Cleanup never replaces the acquisition, conversion, or cancellation failure. */
async function cleanupFreshCanvas(
  canvas: DataCanvas,
  instance: CanvasInstance,
  ctx: Context,
): Promise<void> {
  if (instance.isNew)
    await canvas.drop(instance.canvasId, ctx).catch((error: unknown) =>
      ctx.log.warning('Could not remove a failed occurrence staging', {
        canvas_id: instance.canvasId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}

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
  formation?: string | undefined;
  country?: string | undefined;
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
    input.environment != null ||
    input.country != null ||
    input.formation != null
  );
}

/**
 * Page-position guidance, or `undefined` when this page reached the end of the
 * match set. `shown` counts only the delivered inline rows; the next offset is
 * `offset + shown`, independent of staging. Advancing `offset` is the primary next step —
 * "raise limit" only appears when the requested limit bound the page below the
 * input ceiling; a lower configured page cap is disclosed instead.
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
  const parts = [`Showing occurrences ${offset + 1}–${last} of ${total}.`];
  parts.push(`Advance offset to ${last} for the next page.`);
  if (limit > cap) {
    parts.push(overCapNotice(limit, 'occurrences', cap));
  } else if (cap === limit && limit < MAX_PAGE) {
    parts.push(`Or raise limit (max ${MAX_PAGE}) to pull more per page.`);
  }
  return parts.join(' ');
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
  const selectors = Object.entries(input)
    .filter(
      ([key, value]) => !['limit', 'offset', 'canvas_id'].includes(key) && value !== undefined,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return `No occurrences matched ${selectors}. Verify the taxon with paleobiology_get_taxon, a collection_no with paleobiology_search_collections, or widen these filters.`;
}

/** Render an occurrence's age, echoing interval(s) and Ma. */
function fmtAge(o: OccurrenceRow): string {
  const interval = oneLine(
    o.late_interval ? `${o.early_interval} – ${o.late_interval}` : (o.early_interval ?? ''),
  );
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
  return `${o.paleolat}, ${o.paleolng}${o.paleomodel ? ` [${oneLine(o.paleomodel)}]` : ''}`;
}
