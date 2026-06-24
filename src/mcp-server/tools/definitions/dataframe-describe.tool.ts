/**
 * @fileoverview paleobiology_dataframe_describe — list staged tables and columns.
 * Discover the table and column names on a canvas before writing SQL for
 * paleobiology_dataframe_query.
 * @module mcp-server/tools/definitions/dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const dataframeDescribeTool = tool('paleobiology_dataframe_describe', {
  title: 'paleobiology-mcp-server: describe staged canvas tables',
  description:
    'List the tables and their columns staged on a DataCanvas by paleobiology_search_occurrences. ' +
    'Call this before paleobiology_dataframe_query to discover the exact table_name and column names ' +
    'to reference in SQL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas id returned by paleobiology_search_occurrences when its result spilled.'),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Table name — reference this in paleobiology_dataframe_query SQL.'),
            kind: z.string().describe('Object kind: "table" or "view".'),
            row_count: z.number().describe('Number of rows in the table.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('SQL column type, e.g. VARCHAR, DOUBLE, BIGINT.'),
                    nullable: z
                      .boolean()
                      .optional()
                      .describe('True when the column may contain nulls.'),
                  })
                  .describe('A column in the staged table.'),
              )
              .describe('Columns in the table.'),
          })
          .describe('A table staged on the canvas, with its columns.'),
      )
      .describe('Tables staged on the canvas.'),
  }),
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
    const tables = await instance.describe();
    ctx.log.info('Canvas describe', { canvas_id: input.canvas_id, tables: tables.length });

    return {
      tables: tables.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => {
          const col: { name: string; type: string; nullable?: boolean } = {
            name: c.name,
            type: c.type,
          };
          if (c.nullable != null) col.nullable = c.nullable;
          return col;
        }),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0) {
      return [{ type: 'text', text: 'No tables are staged on this canvas.' }];
    }
    const lines: string[] = [];
    for (const t of result.tables) {
      lines.push(`### ${t.name} (${t.kind}, ${t.row_count} rows)`);
      for (const c of t.columns) {
        lines.push(`- \`${c.name}\` ${c.type}${c.nullable ? ' (nullable)' : ''}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
