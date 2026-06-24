/**
 * @fileoverview paleobiology_search_occurrences — the flagship fossil-occurrence search.
 * Filters by taxon (clade-inclusive base_name or exact taxon_name), geologic
 * interval (named or Ma range), geographic bounding box, and depositional
 * environment. Surfaces modern AND paleo coordinates and both temporal
 * representations on every row. Large result sets spill to a DataCanvas for SQL.
 * @module mcp-server/tools/definitions/search-occurrences.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { EnvironmentFilter, Occurrence, OccurrenceFilter } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

const ENVIRONMENTS = ['marine', 'terrestrial', 'freshwater'] as const;

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
    reference_no: z
      .number()
      .int()
      .optional()
      .describe('PBDB bibliographic reference id for provenance.'),
  })
  .describe('A single fossil occurrence with modern and paleo coordinates, age, and strata.');

const SearchOccurrencesOutputSchema = z.object({
  occurrences: z
    .array(OccurrenceSchema)
    .describe(
      'Inline preview of matching occurrences. The full set is on the canvas when spilled is true.',
    ),
  spilled: z
    .boolean()
    .describe(
      'True when the result exceeded the inline preview and the full set was staged on the canvas.',
    ),
  canvas_id: z
    .string()
    .optional()
    .describe(
      'Canvas id holding the full result — pass to paleobiology_dataframe_query. Absent when DataCanvas is disabled.',
    ),
  table_name: z
    .string()
    .optional()
    .describe('Canvas table holding the full occurrence set. Present only when spilled is true.'),
  row_count: z
    .number()
    .describe('Rows staged on the canvas when spilled; otherwise the preview length.'),
});

/** Inferred output type — the loose shape (optionals carry `| undefined`) the format() helpers read. */
type OccurrenceRow = z.infer<typeof OccurrenceSchema>;

export const searchOccurrencesTool = tool('paleobiology_search_occurrences', {
  title: 'paleobiology-mcp-server: search fossil occurrences',
  description:
    'Search fossil occurrences filtered by taxon, geologic time, geography, and depositional ' +
    'environment — the flagship. Use base_name for a clade and all its descendants (what "Tyrannosaurus ' +
    'occurrences" usually means) or taxon_name for an exact taxon. Bound the age by a named interval ' +
    '(e.g. "Maastrichtian") or a max_ma/min_ma range, and/or a lng/lat bounding box. Every row carries ' +
    'two distinct coordinate systems — modern lng/lat (where the rock is today) and paleo lng/lat (where ' +
    'the landmass sat at deposition) — plus the formation and age interval; never plot a deep-time ' +
    'occurrence on a modern coastline. Resolve a name with paleobiology_get_taxon first if unsure. Broad ' +
    'queries return many rows: an inline preview answers the immediate question, and the full set is ' +
    'staged on a DataCanvas (canvas_id + table_name) for SQL via paleobiology_dataframe_query — count by ' +
    'interval, group by formation/country, map by region.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: z
      .string()
      .optional()
      .describe(
        'Clade-inclusive taxon filter — this taxon and all descendants, e.g. "Dinosauria". The usual choice.',
      ),
    taxon_name: z
      .string()
      .optional()
      .describe(
        'Exact taxon filter — only this taxon, not descendants. Use instead of base_name when you want a single taxon.',
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
        'Older age bound in millions of years ago. Pair with min_ma; alternative to interval.',
      ),
    min_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Younger age bound in millions of years ago. Pair with max_ma; alternative to interval.',
      ),
    lngmin: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Western edge of the bounding box, decimal degrees (−180…180).'),
    lngmax: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Eastern edge of the bounding box, decimal degrees (−180…180).'),
    latmin: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Southern edge of the bounding box, decimal degrees (−90…90).'),
    latmax: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Northern edge of the bounding box, decimal degrees (−90…90).'),
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
      .describe(
        'Maximum occurrences to pull (1–500). Broad queries spill the full set to the canvas regardless.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas id from a prior call to re-stage onto the same workspace. Reusing it REPLACES (overwrites) the prior occurrence table — each search restages the full result, it does not append to or accumulate across earlier ones. Omit to start fresh; the response returns a new id.',
      ),
  }),
  output: SearchOccurrencesOutputSchema,
  enrichment: {
    totalCount: z
      .number()
      .describe('Occurrences returned in the preview (or staged when spilled).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no occurrence matched, when results spilled to the canvas, or when DataCanvas is off.',
      ),
    attribution: z.string().describe('CC-BY data attribution for the Paleobiology Database.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Source' },
  },

  async handler(input, ctx) {
    const filter: OccurrenceFilter = { limit: input.limit };
    if (input.base_name) filter.baseName = input.base_name;
    if (input.taxon_name) filter.taxonName = input.taxon_name;
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

    ctx.enrich({ attribution: PBDB_ATTRIBUTION });

    if (!canvas) {
      // DataCanvas disabled — drain the (capped) result inline; no usable canvas_id.
      const rows: Occurrence[] = [];
      for await (const row of service.searchOccurrences(filter, ctx)) rows.push(row);
      ctx.enrich.total(rows.length);
      if (rows.length === 0) {
        ctx.enrich.notice(emptyNotice(input));
      } else if (rows.length >= input.limit) {
        ctx.enrich.notice(
          `Returned the first ${rows.length} occurrences (the requested limit). Enable DataCanvas ` +
            '(CANVAS_PROVIDER_TYPE=duckdb) to stage the full set for SQL, or narrow the filter.',
        );
      }
      ctx.log.info('Occurrence search (no canvas)', { count: rows.length });
      return { occurrences: rows, spilled: false, row_count: rows.length };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    // The canvas id uses nanoid's URL-safe alphabet, which includes "-" — invalid
    // in an unquoted SQL identifier (the canvas rejects it). Map non-identifier
    // chars to "_" so the table name is always a legal identifier.
    const tableName = `occurrences_${instance.canvasId.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const result = await spillover({
      canvas: instance,
      source: service.searchOccurrences(filter, ctx),
      previewChars: 100_000, // ≈25k tokens inline
      tableName,
      signal: ctx.signal,
    });

    const previewRows = result.previewRows as Occurrence[];
    ctx.enrich.total(result.spilled ? result.handle.rowCount : previewRows.length);

    if (previewRows.length === 0) {
      ctx.enrich.notice(emptyNotice(input));
    } else if (result.spilled) {
      ctx.enrich.notice(
        `Result staged on canvas ${instance.canvasId} as table "${result.handle.tableName}" ` +
          `(${result.handle.rowCount} rows). Showing ${previewRows.length} inline; query the full ` +
          'set with paleobiology_dataframe_query (e.g. count by interval, group by formation).',
      );
    }
    ctx.log.info('Occurrence search', {
      preview: previewRows.length,
      spilled: result.spilled,
      canvas_id: instance.canvasId,
    });

    const out: z.infer<typeof SearchOccurrencesOutputSchema> = {
      occurrences: previewRows,
      spilled: result.spilled,
      canvas_id: instance.canvasId,
      row_count: result.spilled ? result.handle.rowCount : previewRows.length,
    };
    if (result.spilled) out.table_name = result.handle.tableName;
    return out;
  },

  format: (result) => {
    const header = result.spilled
      ? `**${result.row_count} occurrence(s)** — full set staged on canvas \`${result.canvas_id ?? ''}\` as table \`${result.table_name ?? ''}\` (spilled: yes); preview below.`
      : `**${result.occurrences.length} occurrence(s)** (spilled: no${result.canvas_id ? `; canvas \`${result.canvas_id}\`` : ''}).`;
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
      if (o.reference_no != null) lines.push(`**reference_no:** ${o.reference_no}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});

/** Build an empty-result notice echoing the filters. */
function emptyNotice(input: {
  base_name?: string | undefined;
  taxon_name?: string | undefined;
  interval?: string | undefined;
  max_ma?: number | undefined;
  min_ma?: number | undefined;
}): string {
  const taxon = input.base_name ?? input.taxon_name ?? 'any taxon';
  const when =
    input.interval ??
    (input.max_ma != null ? `${input.max_ma}–${input.min_ma ?? 0} Ma` : 'all time');
  return (
    `No occurrences matched ${taxon} in ${when}. Verify the taxon name with paleobiology_get_taxon, ` +
    'widen the interval or bounding box, or drop the environment filter.'
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
