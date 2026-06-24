/**
 * @fileoverview paleobiology://occurrence/{occurrence_no} — one fossil occurrence.
 * Convenience mirror of a single-occurrence read (full show blocks: modern +
 * paleo coords, classification, strata, locality). The same data is reachable
 * for tool-only clients via paleobiology_search_occurrences.
 * @module mcp-server/resources/definitions/occurrence.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPbdbService, isNotFoundError } from '@/services/pbdb/pbdb-service.js';

export const occurrenceResource = resource('paleobiology://occurrence/{occurrence_no}', {
  name: 'Fossil occurrence',
  title: 'paleobiology-mcp-server: fossil occurrence',
  description:
    'Read one fossil occurrence by its integer occurrence_no (obtained from paleobiology_search_occurrences ' +
    'output rows). Returns the accepted and identified names, age as both a named interval and a Ma range, ' +
    'modern and paleo coordinates distinctly, formation/strata, and locality.',
  mimeType: 'application/json',
  params: z.object({
    occurrence_no: z
      .string()
      .regex(/^\d+$/, 'occurrence_no must be a positive integer.')
      .describe(
        'PBDB occurrence id (a bare positive integer), from paleobiology_search_occurrences output.',
      ),
  }),
  errors: [
    {
      reason: 'occurrence_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No PBDB occurrence has the given occurrence_no.',
      recovery: 'Run paleobiology_search_occurrences to obtain a valid occurrence_no, then retry.',
    },
  ],
  async handler(params, ctx) {
    const occurrenceNo = Number(params.occurrence_no);
    try {
      return await getPbdbService().getOccurrence(occurrenceNo, ctx);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw ctx.fail(
          'occurrence_not_found',
          `No occurrence with occurrence_no ${occurrenceNo}.`,
          {
            ...ctx.recoveryFor('occurrence_not_found'),
          },
        );
      }
      throw err;
    }
  },
});
