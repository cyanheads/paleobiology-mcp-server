/**
 * @fileoverview paleobiology_get_references — resolve the reference_no values on
 * occurrence and collection rows to bibliographic citations. One PBDB `refs/list`
 * request per call resolves up to {@link REFERENCES_PER_CALL} distinct ids; the
 * rest come back in remaining_reference_nos. A miss is a result (not_found),
 * never an error.
 * @module mcp-server/tools/definitions/get-references.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { oneLine } from '@/mcp-server/tools/one-line.js';
import { emitNotice } from '@/mcp-server/tools/pbdb-notices.js';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

/** Distinct ids resolved per call — one `refs/list` request. */
export const REFERENCES_PER_CALL = 25;

/** Most ids one call accepts — the largest page a search tool returns. */
const MAX_REFERENCE_NOS = 500;

const NameSchema = z
  .object({
    first_name: z.string().optional().describe('Given name or initials, when recorded.'),
    last_name: z.string().optional().describe('Family name, when recorded.'),
  })
  .describe('A person named on the reference.');

/** One reference, as both paleobiology_get_references and the reference resource return it. */
export const ReferenceSchema = z
  .object({
    reference_no: z.number().int().describe('PBDB bibliographic reference id.'),
    citation: z
      .string()
      .describe(
        'Full citation as PBDB formats it, plain text, relayed as entered (authors, year, title, publication, volume, pages).',
      ),
    publication_type: z
      .string()
      .optional()
      .describe('Kind of publication, e.g. "journal article", "book chapter", "Ph.D. thesis".'),
    title: z
      .string()
      .optional()
      .describe('Title of the work. A book may carry its title in publication instead.'),
    year: z.string().optional().describe('Publication year as PBDB records it.'),
    authors: z
      .array(NameSchema)
      .optional()
      .describe(
        'Authors in citation order. PBDB stores at most 255 characters of additional authors, so a long list can end early or mid-name.',
      ),
    editors: z.array(NameSchema).optional().describe('Editors of the containing volume.'),
    publication: z
      .string()
      .optional()
      .describe('Journal, book, or series the work appeared in (or the school, for a thesis).'),
    volume: z.string().optional().describe('Volume, as recorded.'),
    issue: z.string().optional().describe('Issue or number, as recorded (e.g. "3-4").'),
    first_page: z
      .string()
      .optional()
      .describe('First page as recorded — not always numeric (e.g. "viii").'),
    last_page: z.string().optional().describe('Last page as recorded.'),
    publisher: z.string().optional().describe('Publisher, when recorded.'),
    language: z.string().optional().describe('Language of the work.'),
    doi: z.string().optional().describe('DOI, when recorded.'),
  })
  .describe('A bibliographic reference from PBDB.');

export const getReferencesTool = tool('paleobiology_get_references', {
  title: 'paleobiology-mcp-server: get bibliographic references',
  description: `Resolve PBDB reference_no values — the source publication on every paleobiology_search_occurrences and paleobiology_search_collections row — to full citations with authors, year, title, publication, volume, pages, and DOI. Pass the ids from a page of rows in one call: the first ${REFERENCES_PER_CALL} distinct ids are resolved and any beyond that come back in remaining_reference_nos for a follow-up call. Ids PBDB has no reference for are listed in not_found. Results keep the order the ids were given.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    reference_nos: z
      .array(
        z
          .number()
          .int()
          .positive()
          .describe('A reference_no from an occurrence or collection row.'),
      )
      .min(1)
      .max(MAX_REFERENCE_NOS)
      .describe(
        `PBDB reference ids to resolve, from the reference_no field of paleobiology_search_occurrences or paleobiology_search_collections rows. Repeats are resolved once. Up to ${MAX_REFERENCE_NOS} accepted; the first ${REFERENCES_PER_CALL} distinct ids are resolved per call.`,
      ),
  }),
  output: z.object({
    references: z
      .array(ReferenceSchema)
      .describe('The references PBDB has, in the order their ids were given.'),
    not_found: z
      .array(z.number().int().describe('A reference_no PBDB has no reference for.'))
      .describe('Requested ids PBDB has no reference for. Empty when every id resolved.'),
    remaining_reference_nos: z
      .array(z.number().int().describe('A reference_no not yet resolved.'))
      .optional()
      .describe(
        `Distinct ids past the first ${REFERENCES_PER_CALL}, not resolved by this call — pass them as reference_nos to resolve the rest. Present only when the input held more than ${REFERENCES_PER_CALL} distinct ids.`,
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when some ids had no PBDB reference, or when more ids remain than one call resolves.',
      ),
    attribution: z.string().describe('CC-BY data attribution for the Paleobiology Database.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Source' },
  },

  async handler(input, ctx) {
    const distinct = [...new Set(input.reference_nos)];
    const batch = distinct.slice(0, REFERENCES_PER_CALL);
    const remaining = distinct.slice(REFERENCES_PER_CALL);

    const lookup = await getPbdbService().getReferences(batch, ctx);
    ctx.enrich({ attribution: PBDB_ATTRIBUTION });
    ctx.log.info('References resolved', {
      requested: batch.length,
      found: lookup.references.length,
      not_found: lookup.not_found.length,
      remaining: remaining.length,
    });

    emitNotice(
      ctx,
      missNotice(lookup.not_found),
      remaining.length > 0
        ? `Looked up the first ${batch.length} of ${distinct.length} distinct reference_nos. Call paleobiology_get_references again with remaining_reference_nos for the rest.`
        : undefined,
    );
    return remaining.length > 0 ? { ...lookup, remaining_reference_nos: remaining } : lookup;
  },

  format: (result) => {
    const lines: string[] = [];
    for (const ref of result.references) {
      lines.push(`### reference_no ${ref.reference_no}`, `> ${oneLine(ref.citation)}`);
      const fields: [string, string | undefined][] = [
        ['publication_type', ref.publication_type],
        ['title', ref.title],
        ['year', ref.year],
        ['authors', fmtNames(ref.authors)],
        ['editors', fmtNames(ref.editors)],
        ['publication', ref.publication],
        ['volume', ref.volume],
        ['issue', ref.issue],
        ['first_page', ref.first_page],
        ['last_page', ref.last_page],
        ['publisher', ref.publisher],
        ['language', ref.language],
        ['doi', ref.doi],
      ];
      for (const [label, value] of fields) {
        if (value) lines.push(`**${label}:** ${oneLine(value)}`);
      }
      lines.push('');
    }
    lines.push(
      `**not_found:** ${result.not_found.length > 0 ? result.not_found.join(', ') : 'none'}`,
    );
    if (result.remaining_reference_nos) {
      lines.push(`**remaining_reference_nos:** ${result.remaining_reference_nos.join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** The miss notice, naming every id PBDB had no reference for; `undefined` when none missed. */
function missNotice(notFound: number[]): string | undefined {
  if (notFound.length === 0) return;
  const label = notFound.length === 1 ? 'reference_no' : 'reference_nos';
  return `PBDB has no reference for ${label} ${notFound.join(', ')}. Take reference_no values from paleobiology_search_occurrences or paleobiology_search_collections rows.`;
}

/** Render names as `first last; …`. */
function fmtNames(names: z.infer<typeof NameSchema>[] | undefined): string | undefined {
  return names?.map((n) => [n.first_name, n.last_name].filter(Boolean).join(' ')).join('; ');
}
