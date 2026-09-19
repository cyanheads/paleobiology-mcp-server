/**
 * @fileoverview paleobiology_get_taxon — taxonomic record + fossil temporal range.
 * Resolves a name or taxon_no to the accepted name, rank, classification, parent,
 * immediate children, occurrence count, and first/last-appearance (FAD/LAD)
 * range. The name-resolution gateway the occurrence, diversity, and collection
 * searches depend on — its taxon_no is their `base_id`.
 * @module mcp-server/tools/definitions/get-taxon.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  getPbdbService,
  isNotFoundError,
  TAXON_CHILDREN_PAGE_SIZE,
} from '@/services/pbdb/pbdb-service.js';
import type { Taxon, TaxonLookup } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

/**
 * The higher-classification block PBDB's `class` show block yields. Exported so
 * occurrence rows declare the identical shape — both describe the same
 * service-layer `TaxonClassification`, and a second copy would drift.
 */
export const ClassificationSchema = z
  .object({
    phylum: z.string().optional().describe('Phylum, when classified.'),
    class: z.string().optional().describe('Class, when classified.'),
    order: z
      .string()
      .optional()
      .describe('Order, when classified (PBDB sentinel orders are omitted).'),
    family: z.string().optional().describe('Family, when classified.'),
    genus: z.string().optional().describe('Genus, when classified.'),
  })
  .describe(
    'Higher classification of the taxon. Each level is present only when PBDB resolves it.',
  );

const AppearanceSchema = z
  .object({
    max_ma: z.number().optional().describe('Older bound of the appearance window (Ma).'),
    min_ma: z.number().optional().describe('Younger bound of the appearance window (Ma).'),
    interval: z
      .string()
      .optional()
      .describe('Named geologic interval of this appearance, when known.'),
  })
  .describe('A first- or last-appearance window. Empty when PBDB has no dated occurrences.');

const ChildSchema = z
  .object({
    taxon_no: z
      .number()
      .int()
      .describe('PBDB taxon id of the child — chain into paleobiology_get_taxon.'),
    name: z.string().optional().describe('Child taxon name.'),
    rank: z.string().optional().describe('Child taxon rank, e.g. "genus" or "subfamily".'),
    occurrence_count: z
      .number()
      .optional()
      .describe('Fossil occurrence count for the child, when reported.'),
    synonym_of: z
      .string()
      .optional()
      .describe('Present when this child is a synonym; names the accepted taxon it folds into.'),
  })
  .describe('An immediate child taxon stub.');

const TaxonOutputSchema = z.object({
  taxon_no: z
    .number()
    .int()
    .describe(
      'Accepted PBDB taxon id — the canonical id for this taxon. Pass it as base_id to paleobiology_search_occurrences, paleobiology_get_diversity, or paleobiology_search_collections to filter on this clade without re-sending a name.',
    ),
  accepted_name: z.string().describe('PBDB accepted name (may differ from the searched name).'),
  rank: z.string().describe('Taxonomic rank, e.g. "genus", "family", "order".'),
  parent_no: z
    .number()
    .int()
    .optional()
    .describe('PBDB taxon id of the immediate parent, when known.'),
  parent_name: z.string().optional().describe('Name of the immediate parent taxon, when known.'),
  classification: ClassificationSchema,
  extant: z
    .boolean()
    .describe('True if the clade survives to the present day; false if entirely extinct.'),
  occurrence_count: z
    .number()
    .optional()
    .describe('Number of fossil occurrences recorded in PBDB, when reported.'),
  first_appearance: AppearanceSchema,
  last_appearance: AppearanceSchema,
  children: z
    .array(ChildSchema)
    .optional()
    .describe(
      `One page of immediate child taxa, at most ${TAXON_CHILDREN_PAGE_SIZE} — present only when show_children was true. A taxon with more children than that returns a page, not the full list; read children_truncated before treating it as complete.`,
    ),
  children_offset: z
    .number()
    .int()
    .optional()
    .describe(
      'Position in the child list this page started at (0 is the first child). Present only when show_children was true.',
    ),
  children_truncated: z
    .boolean()
    .optional()
    .describe(
      `True when more immediate children remain past this page — re-call with children_offset advanced by ${TAXON_CHILDREN_PAGE_SIZE} to read the next. False means this page runs to the end of the child list. Present only when show_children was true.`,
    ),
});

/** The shaped taxon contract both paleobiology_get_taxon and the taxon resource return. */
export type TaxonOutput = z.infer<typeof TaxonOutputSchema>;

/**
 * Shape a service-layer {@link Taxon} into the {@link TaxonOutputSchema} contract:
 * the FAD/LAD windows lifted to the top level, absent optional fields dropped.
 * The single source of taxon shaping for both paleobiology_get_taxon and the
 * paleobiology://taxon/{taxon_no} resource, so the two surfaces cannot drift.
 *
 * accepted_name and rank are required outputs — PBDB returns both for every
 * resolved taxon (rank via taxon_rank, or accepted_rank on a by-id lookup), so a
 * record missing either is unusable; fail loud rather than fabricate them.
 */
export function shapeTaxon(taxon: Taxon): TaxonOutput {
  if (!taxon.accepted_name || !taxon.rank) {
    throw serviceUnavailable(
      `PBDB returned taxon ${taxon.taxon_no} without an accepted name or rank.`,
    );
  }
  const out: TaxonOutput = {
    taxon_no: taxon.taxon_no,
    accepted_name: taxon.accepted_name,
    rank: taxon.rank,
    classification: taxon.classification,
    extant: taxon.extant,
    first_appearance: taxon.range.first_appearance,
    last_appearance: taxon.range.last_appearance,
  };
  if (taxon.parent_no != null) out.parent_no = taxon.parent_no;
  if (taxon.parent_name) out.parent_name = taxon.parent_name;
  if (taxon.occurrence_count != null) out.occurrence_count = taxon.occurrence_count;
  if (taxon.children) {
    out.children = taxon.children;
    // The child pull is a second upstream request whose page position and
    // truncation verdict have no home on the child rows themselves — they ride
    // the Taxon out of the service and get lifted to the top level here.
    out.children_offset = taxon.children_offset ?? 0;
    out.children_truncated = taxon.children_truncated ?? false;
  }
  return out;
}

export const getTaxonTool = tool('paleobiology_get_taxon', {
  title: 'paleobiology-mcp-server: get taxon record and fossil range',
  description:
    'Resolve a taxon by name (e.g. "Tyrannosaurus") or by integer taxon_no to its accepted name, ' +
    'rank, higher classification, immediate parent, fossil occurrence count, and first/last ' +
    'appearance (FAD/LAD) range in millions of years — "when did this clade exist, and what is ' +
    'it." Run this first to resolve a name into the accepted name and taxon_no, then pass that id as ' +
    'base_id to paleobiology_search_occurrences, paleobiology_get_diversity, or ' +
    'paleobiology_search_collections for a clade-inclusive filter that carries no name ambiguity (the ' +
    'same id also appears as accepted_no on occurrence rows). Set show_children to also list ' +
    'immediate child taxa. PBDB ' +
    "taxonomy is opinionated and can differ from GBIF's backbone, so the accepted name may differ " +
    'from the name you searched.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Taxon name to resolve, e.g. "Tyrannosaurus" or "Ammonoidea". Provide this or taxon_no.',
      ),
    taxon_no: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'PBDB taxon id from a prior get_taxon, or accepted_no on an occurrence row. Provide this or name.',
      ),
    show_children: z
      .boolean()
      .default(false)
      .describe(
        `When true, include a page of the immediate child taxa of this taxon (at most ${TAXON_CHILDREN_PAGE_SIZE} per call — children_truncated says whether more remain).`,
      ),
    children_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Number of immediate children to skip before the returned page — used only when show_children is true. Advance it by ${TAXON_CHILDREN_PAGE_SIZE} while children_truncated is true to walk the whole child list.`,
      ),
  }),
  output: TaxonOutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the child list was cut off at the per-page cap (naming the children_offset that reaches the next page), or when children_offset ran past the end of the child list.',
      ),
    attribution: z.string().describe('CC-BY data attribution for the Paleobiology Database.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Source' },
  },
  errors: [
    {
      reason: 'taxon_not_found',
      code: JsonRpcErrorCode.NotFound,
      // A name that resolves to nothing is an ordinary answer on a lookup tool, not
      // an incident — keep it out of the error stream operators alert on.
      severity: 'info',
      when: 'The name or taxon_no resolved to no PBDB taxon.',
      recovery:
        'If searching by name, check the spelling or try a higher rank (genus → family). If searching by taxon_no, re-run paleobiology_get_taxon by name to obtain a valid id.',
    },
    {
      reason: 'missing_selector',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither name nor taxon_no was provided.',
      recovery: 'Provide either a taxon name or a positive integer taxon_no to identify the taxon.',
    },
  ],

  async handler(input, ctx) {
    if (!input.name && input.taxon_no == null) {
      throw ctx.fail('missing_selector', 'Provide either a name or a taxon_no.', {
        ...ctx.recoveryFor('missing_selector'),
      });
    }

    const args: TaxonLookup = { showChildren: input.show_children };
    if (input.name) args.name = input.name;
    if (input.taxon_no != null) args.taxonNo = input.taxon_no;
    if (input.show_children) args.childrenOffset = input.children_offset;

    let taxon: Taxon;
    try {
      taxon = await getPbdbService().getTaxon(args, ctx);
    } catch (err) {
      // The service throws notFound (incl. PBDB's HTTP-200 errors[] case) — remap
      // to the typed contract reason so the recovery hint reaches the wire.
      if (isNotFoundError(err)) {
        throw ctx.fail(
          'taxon_not_found',
          input.name
            ? `No taxon matched "${input.name}".`
            : `No taxon with taxon_no ${input.taxon_no}.`,
          { ...ctx.recoveryFor('taxon_not_found') },
        );
      }
      throw err;
    }

    ctx.enrich({ attribution: PBDB_ATTRIBUTION });
    const out = shapeTaxon(taxon);
    ctx.log.info('Taxon resolved', {
      taxon_no: taxon.taxon_no,
      name: taxon.accepted_name,
      children: out.children?.length,
      children_offset: out.children_offset,
      children_truncated: out.children_truncated,
    });

    // A cut-off child list must never read as the complete one, and an empty page
    // past the end of a real child list is a paging mistake, not a childless taxon.
    if (out.children) {
      const start = out.children_offset ?? 0;
      const last = start + out.children.length;
      if (out.children_truncated) {
        ctx.enrich.notice(
          `Showing immediate children ${start + 1}–${last} of ${out.accepted_name}; more remain. ` +
            `Advance children_offset to ${last} for the next page.`,
        );
      } else if (out.children.length === 0 && start > 0) {
        ctx.enrich.notice(
          `No immediate children at children_offset ${start} — the child list of ${out.accepted_name} ` +
            'ends before it. Lower children_offset (0 starts at the first child).',
        );
      }
    }
    return out;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.accepted_name}`);
    const meta = [
      `**taxon_no:** ${result.taxon_no}`,
      `**rank:** ${result.rank}`,
      `**extant:** ${result.extant ? 'yes' : 'no (extinct)'}`,
    ];
    if (result.occurrence_count != null) meta.push(`**occurrences:** ${result.occurrence_count}`);
    lines.push(meta.join(' | '));
    if (result.parent_name || result.parent_no != null) {
      lines.push(
        `**parent:** ${result.parent_name ?? ''}${result.parent_no != null ? ` (#${result.parent_no})` : ''}`.trim(),
      );
    }

    const cls = fmtClassification(result.classification);
    if (cls) lines.push(`**classification:** ${cls}`);

    lines.push(`**first appearance:** ${fmtWindow(result.first_appearance)}`);
    lines.push(`**last appearance:** ${fmtWindow(result.last_appearance)}`);

    if (result.children && result.children.length > 0) {
      lines.push('', `**children (${result.children.length}):**`);
      for (const c of result.children) {
        const tail: string[] = [`#${c.taxon_no}`];
        if (c.rank) tail.push(c.rank);
        if (c.occurrence_count != null) tail.push(`${c.occurrence_count} occ`);
        if (c.synonym_of) tail.push(`synonym of ${c.synonym_of}`);
        lines.push(`- ${c.name ?? `taxon #${c.taxon_no}`} (${tail.join(', ')})`);
      }
    }
    // Rendered whenever either field is set — not nested under the child list, so a
    // truncated page and an empty past-the-end page both disclose in content[] too.
    if (result.children_offset != null || result.children_truncated != null) {
      const start = result.children_offset ?? 0;
      const last = start + (result.children?.length ?? 0);
      lines.push(
        '',
        result.children_truncated
          ? `**children page:** children_offset ${start}, through child ${last} — children_truncated: yes, more remain. Re-call with children_offset ${last}.`
          : `**children page:** children_offset ${start}, through child ${last} — children_truncated: no, this page reaches the end of the child list.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Render a higher classification as `phylum: X › class: Y › …`, or '' when PBDB
 * resolved no level. Exported alongside {@link ClassificationSchema} so occurrence
 * rows render the identical string — the two surfaces describe the same block.
 */
export function fmtClassification(cls: z.infer<typeof ClassificationSchema> | undefined): string {
  if (!cls) return '';
  return (['phylum', 'class', 'order', 'family', 'genus'] as const)
    .filter((k) => cls[k])
    .map((k) => `${k}: ${cls[k]}`)
    .join(' › ');
}

/** Render a FAD/LAD window, preserving unknowns. */
function fmtWindow(w: {
  max_ma?: number | undefined;
  min_ma?: number | undefined;
  interval?: string | undefined;
}): string {
  const ages = w.max_ma != null && w.min_ma != null ? `${w.max_ma}–${w.min_ma} Ma` : 'age unknown';
  return w.interval ? `${w.interval} (${ages})` : ages;
}
