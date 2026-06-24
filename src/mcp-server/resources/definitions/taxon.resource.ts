/**
 * @fileoverview paleobiology://taxon/{taxon_no} — one taxon record + fossil range.
 * Mirror of paleobiology_get_taxon by taxon_no (accepted name, rank, classification,
 * parent, FAD/LAD range). The same data is reachable for tool-only clients via
 * paleobiology_get_taxon.
 * @module mcp-server/resources/definitions/taxon.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPbdbService, isNotFoundError } from '@/services/pbdb/pbdb-service.js';

export const taxonResource = resource('paleobiology://taxon/{taxon_no}', {
  name: 'Taxon record',
  title: 'paleobiology-mcp-server: taxon record',
  description:
    'Read one taxon by its integer taxon_no (from paleobiology_get_taxon, or accepted_no on an occurrence ' +
    'row). Returns the accepted name, rank, higher classification, immediate parent, fossil occurrence ' +
    'count, and first/last appearance (FAD/LAD) range in millions of years.',
  mimeType: 'application/json',
  params: z.object({
    taxon_no: z
      .string()
      .regex(/^\d+$/, 'taxon_no must be a positive integer.')
      .describe(
        'PBDB taxon id (a bare positive integer), from paleobiology_get_taxon or an occurrence accepted_no.',
      ),
  }),
  errors: [
    {
      reason: 'taxon_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No PBDB taxon has the given taxon_no.',
      recovery: 'Run paleobiology_get_taxon by name to obtain a valid taxon_no, then retry.',
    },
  ],
  async handler(params, ctx) {
    const taxonNo = Number(params.taxon_no);
    try {
      return await getPbdbService().getTaxon({ taxonNo, showChildren: false }, ctx);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw ctx.fail('taxon_not_found', `No taxon with taxon_no ${taxonNo}.`, {
          ...ctx.recoveryFor('taxon_not_found'),
        });
      }
      throw err;
    }
  },
});
