/**
 * @fileoverview paleobiology_dataframe_query — read-only SQL over staged occurrences.
 * Runs a SELECT against the occurrence result sets paleobiology_search_occurrences
 * stages on a DataCanvas: count by interval, group by formation/country, roll up
 * by family from the classification JSON column, map by region. Mandatory
 * companion to the spill path. Rows are cut to the inline response budget; the
 * notice names the SQL LIMIT/OFFSET that reads the rest.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { fitRows, jsonItemBytes, utf8Bytes } from '@/mcp-server/tools/inline-budget.js';
import { emitNotice } from '@/mcp-server/tools/pbdb-notices.js';
import { getCanvas } from '@/services/canvas-accessor.js';

const DataframeQueryOutputSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'Result rows in query order, ending at a whole row where more would exceed the inline response size. Keys are the selected column names. When rows were left out, the notice says how many are shown and the LIMIT/OFFSET that reads the rest.',
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
    "Run a read-only SQL SELECT against occurrence result sets staged on a DataCanvas by paleobiology_search_occurrences. This is how you analyze a large fossil set without re-fetching it: count occurrences by early_interval, group by formation, country (cc), or accepted_name, or filter by a paleo/modern coordinate range. The classification column is JSON — roll up by rank with json_extract_string(classification, '$.family') (also $.phylum, $.class, $.order, $.genus). Staged rows are occurrences, so collection-only fields such as lithology are not present. Reference tables by the table_name that paleobiology_search_occurrences returned — call paleobiology_dataframe_describe first if you do not know the table or column names. A result too large to return inline comes back as its first rows, with a notice naming the ORDER BY … LIMIT/OFFSET that reads the rest. SELECT only; writes and file-reading functions are rejected.",
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
        'Guidance when the result was cut to fit the inline response size (rows shown, the LIMIT/OFFSET that continues, and when to stop), when a single row was too large to show, or when row_count stopped at the canvas row cap.',
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
    const shown = fitRows(result.rows, QUERY_ROW_SURFACES);
    ctx.log.info('Canvas query', { canvas_id: input.canvas_id, rows: result.rowCount, shown });
    emitNotice(ctx, rowCapNotice(result), cutNotice(shown, result.rows.length));

    const out: z.infer<typeof DataframeQueryOutputSchema> = {
      rows: result.rows.slice(0, shown),
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

/**
 * Indentation of a row inside the framework's `JSON.stringify(result, null, 2)`
 * fallback rendering of `{ rows: [ … ] }` — two levels deep.
 */
const ROW_INDENT = '    ';

/**
 * What one row costs on each client surface: a compact JSON array element in
 * `structuredContent`, and a pretty-printed one (indented, plus its `,\n`
 * separator) in the `content[]` JSON fallback.
 */
const QUERY_ROW_SURFACES = [
  jsonItemBytes,
  (row: Record<string, unknown>) =>
    utf8Bytes(ROW_INDENT + JSON.stringify(row, null, 2).replaceAll('\n', `\n${ROW_INDENT}`)) + 2,
];

/** Discloses that row_count stopped at the canvas row cap, or `undefined` when it is exact. */
function rowCapNotice(result: QueryResult): string | undefined {
  if (!result.truncated) return;
  return (
    `The query produced more than ${result.rowCount} rows — counting stopped at the ` +
    `${result.rowCount}-row cap, so row_count is a floor, not the total. Wrap the query in ` +
    'SELECT COUNT(*) FROM (…) for the exact count.'
  );
}

/**
 * Names the rows shown and the SQL that reads the rest, or `undefined` when every
 * returned row fits. The continuation is relative to the query as sent — its own
 * OFFSET plus the rows shown — so it holds on the first page and on every page a
 * caller reaches by following it.
 */
function cutNotice(shown: number, returned: number): string | undefined {
  if (shown === returned) return;
  if (shown === 0) {
    return (
      'The first result row alone exceeds the inline response size, so it is withheld and no rows ' +
      'are shown. Select fewer or narrower columns so a row fits, or step past it with OFFSET over ' +
      'a stable ORDER BY.'
    );
  }
  return (
    `Showing the first ${shown} of the ${returned} rows returned — the rest would exceed the inline ` +
    'response size. Read on over a stable order: ORDER BY columns unique per row, set LIMIT ' +
    `${shown}, and raise the query's OFFSET by ${shown} (OFFSET ${shown} if it has none) for each ` +
    `next page, until a page returns fewer than ${shown} rows. If the query had its own LIMIT, stop ` +
    "once the pages read add up to it, lowering the last page's LIMIT to the rows that remain. A " +
    'query without ORDER BY has no fixed row order, so add one and restart that walk at OFFSET 0.'
  );
}
