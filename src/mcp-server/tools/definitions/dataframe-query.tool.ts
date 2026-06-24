/**
 * @fileoverview paleobiology_dataframe_query — read-only SQL over staged occurrences.
 * Runs a SELECT against the occurrence result sets paleobiology_search_occurrences
 * stages on a DataCanvas: count by interval, group by formation/country/lithology,
 * map by region. Mandatory companion to the spill path.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

const DataframeQueryOutputSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe('Result rows (capped at the canvas row limit). Keys are the selected column names.'),
  row_count: z.number().describe('Number of rows in the full result before any row cap.'),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the result exceeded the canvas row cap and rows were trimmed.'),
});

export const dataframeQueryTool = tool('paleobiology_dataframe_query', {
  title: 'paleobiology-mcp-server: query staged occurrences with SQL',
  description:
    'Run a read-only SQL SELECT against occurrence result sets staged on a DataCanvas by ' +
    'paleobiology_search_occurrences. This is how you analyze a large fossil set without re-fetching ' +
    'it: count occurrences by interval, group by formation, country (cc), or lithology, or filter by ' +
    'a paleo/modern coordinate range. Reference tables by the table_name that search_occurrences ' +
    'returned — call paleobiology_dataframe_describe first if you do not know the table or column ' +
    'names. SELECT only; writes and file-reading functions are rejected.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas id returned by paleobiology_search_occurrences when its result spilled.'),
    sql: z
      .string()
      .describe(
        'A read-only SQL SELECT. Reference tables by the names paleobiology_search_occurrences / _describe returned.',
      ),
  }),
  output: DataframeQueryOutputSchema,
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled on this deployment (CANVAS_PROVIDER_TYPE is not duckdb).',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb (and install @duckdb/node-api) to enable SQL over staged occurrence results.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled', 'DataCanvas is not enabled on this deployment.', {
        ...ctx.recoveryFor('canvas_disabled'),
      });
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    ctx.log.info('Canvas query', { canvas_id: input.canvas_id, rows: result.rowCount });

    const out: z.infer<typeof DataframeQueryOutputSchema> = {
      rows: result.rows,
      row_count: result.rowCount,
    };
    if (result.truncated) out.truncated = true;
    return out;
  },

  // No format() override — the rows are a genuinely dynamic record shape
  // (arbitrary SELECT columns), so the framework's JSON-stringify fallback is
  // the honest renderer (a static format() can't enumerate dynamic keys, and
  // format-parity can't verify them). structuredContent carries the full rows.
});
