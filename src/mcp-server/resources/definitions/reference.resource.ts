/**
 * @fileoverview paleobiology://reference/{reference_no} — one bibliographic
 * reference. Mirror of paleobiology_get_references for a single id (same record,
 * same service method); tool-only clients reach the same data through that tool.
 * @module mcp-server/resources/definitions/reference.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

export const referenceResource = resource('paleobiology://reference/{reference_no}', {
  name: 'Bibliographic reference',
  title: 'paleobiology-mcp-server: bibliographic reference',
  description:
    'Read one bibliographic reference by its integer reference_no (from a paleobiology_search_occurrences or paleobiology_search_collections row). Returns the formatted citation, authors, year, title, publication, volume, pages, and DOI, plus an attribution field carrying the CC BY 4.0 source credit.',
  mimeType: 'application/json',
  params: z.object({
    reference_no: z
      .string()
      .regex(/^[1-9]\d{0,14}$/, 'reference_no must be a positive integer.')
      .describe(
        'PBDB reference id (a bare positive integer), from the reference_no field of an occurrence or collection row.',
      ),
  }),
  errors: [
    {
      reason: 'reference_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'info',
      when: 'No PBDB reference has the given reference_no.',
      recovery:
        'Take a reference_no from a paleobiology_search_occurrences or paleobiology_search_collections row, then retry.',
    },
  ],
  async handler(params, ctx) {
    const referenceNo = Number(params.reference_no);
    const { references } = await getPbdbService().getReferences([referenceNo], ctx);
    const [reference] = references;
    if (!reference) {
      throw ctx.fail('reference_not_found', `No PBDB reference with reference_no ${referenceNo}.`, {
        ...ctx.recoveryFor('reference_not_found'),
      });
    }
    // Resources have no enrichment trailer, so the CC BY credit rides as a payload field.
    return { ...reference, attribution: PBDB_ATTRIBUTION };
  },
});
