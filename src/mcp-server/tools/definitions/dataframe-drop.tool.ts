/**
 * @fileoverview paleobiology_dataframe_drop — drop a staged canvas table.
 * Frees memory before the canvas TTL expires. Opt-in: this definition is
 * registered only when PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true (off by default),
 * so it is absent from tools/list otherwise.
 * @module mcp-server/tools/definitions/dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const dataframeDropTool = tool('paleobiology_dataframe_drop', {
  title: 'paleobiology-mcp-server: drop a staged canvas table',
  description:
    'Drop a single staged table from a DataCanvas to free memory before its TTL expires. Reference ' +
    'the table by the table_name paleobiology_search_occurrences returned or paleobiology_dataframe_describe ' +
    'listed. Dropping a table that does not exist is reported as dropped=false, not an error.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas id holding the table to drop — returned by paleobiology_search_occurrences when its result spilled.',
    ),
    table_name: z.string().describe('Name of the staged table to drop.'),
  }),
  output: z.object({
    dropped: z
      .boolean()
      .describe(
        'True when the table existed and was dropped; false when no such table was present.',
      ),
    table_name: z.string().describe('The table name that was targeted.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled on this deployment (CANVAS_PROVIDER_TYPE is not duckdb).',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb (and install @duckdb/node-api) to enable canvas operations.',
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
    const dropped = await instance.drop(input.table_name);
    ctx.log.info('Canvas drop', {
      canvas_id: input.canvas_id,
      table_name: input.table_name,
      dropped,
    });
    return { dropped, table_name: input.table_name };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped table "${result.table_name}".`
        : `No table named "${result.table_name}" was present (nothing dropped).`,
    },
  ],
});
