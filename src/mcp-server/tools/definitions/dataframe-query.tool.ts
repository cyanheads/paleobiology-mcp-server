/**
 * @fileoverview paleobiology_dataframe_query — read-only SQL over staged occurrences.
 * Runs a SELECT against the occurrence result sets paleobiology_search_occurrences
 * stages on a DataCanvas: count by interval, group by formation/country, roll up
 * by family from the classification JSON column, map by region. Mandatory
 * companion to the spill path. Returns every row supplied by the canvas; a
 * capped result names the SQL LIMIT/OFFSET that reads the rest.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { emitNotice } from '@/mcp-server/tools/pbdb-notices.js';
import { getCanvas } from '@/services/canvas-accessor.js';

const DataframeQueryOutputSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'Every result row supplied by the canvas, in query order. Keys are the selected column names. Use SQL LIMIT/OFFSET to choose smaller pages.',
    ),
  row_count: z
    .number()
    .describe(
      'Rows the query produced, counted up to the canvas row cap — exact unless truncated is true, when it equals the cap and the result is larger.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when the query produced more rows than the canvas row cap, so row_count stopped counting at the cap.',
    ),
});

export const dataframeQueryTool = tool('paleobiology_dataframe_query', {
  title: 'paleobiology-mcp-server: query staged occurrences with SQL',
  description:
    "Run a read-only SQL SELECT against occurrence result sets staged on a DataCanvas by paleobiology_search_occurrences. This is how you analyze a large fossil set without re-fetching it: count occurrences by early_interval, group by formation, country (cc), or accepted_name, or filter by a paleo/modern coordinate range. The classification column is JSON — roll up by rank with json_extract_string(classification, '$.family') (also $.phylum, $.class, $.order, $.genus). Staged rows are occurrences, so collection-only fields such as lithology are not present. Reference tables by the table_name that paleobiology_search_occurrences returned — call paleobiology_dataframe_describe first if you do not know the table or column names. Every row supplied by the canvas is returned; choose smaller pages with SQL LIMIT/OFFSET. Results exceeding the canvas row cap include a notice naming the stable ORDER BY … LIMIT/OFFSET continuation. SELECT only; writes and file-reading functions are rejected.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas id returned by paleobiology_search_occurrences when its result spilled.',
    ),
    sql: z
      .string()
      .describe(
        'A read-only SQL SELECT. Reference tables by the names paleobiology_search_occurrences / paleobiology_dataframe_describe returned.',
      ),
  }),
  output: DataframeQueryOutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when row_count stopped at the canvas row cap, including SQL LIMIT/OFFSET continuation.',
      ),
  },
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
      throw ctx.fail('canvas_disabled', 'DataCanvas is not enabled on this deployment.');
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    const shown = result.rows.length;
    ctx.log.info('Canvas query', { canvas_id: input.canvas_id, rows: result.rowCount, shown });
    emitNotice(ctx, rowCapNotice(result));

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
  // format-parity can't verify them). structuredContent carries the same rows.
});

/** Discloses that row_count stopped at the canvas row cap, or `undefined` when it is exact. */
function rowCapNotice(result: QueryResult): string | undefined {
  if (!result.truncated) return;
  return `The query produced more than ${result.rowCount} rows — counting stopped at the ${result.rowCount}-row cap, so row_count is a floor, not the total. Wrap the query in SELECT COUNT(*) FROM (…) for the exact count. Read on with ORDER BY columns unique per row, set LIMIT ${result.rows.length}, and raise the query's OFFSET by ${result.rows.length} (OFFSET ${result.rows.length} if it has none) for each next page, until a page returns fewer rows. If the query had its own LIMIT, stop once the pages read add up to it, lowering the last page's LIMIT to the rows that remain. A query without ORDER BY has no fixed row order, so add one and restart at OFFSET 0.`;
}
