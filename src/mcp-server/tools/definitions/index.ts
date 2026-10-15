/**
 * @fileoverview Tool definitions barrel — assembles allToolDefinitions for createApp().
 *
 * Registers the six domain tools and the DataCanvas trio. The trio is callable
 * only when DataCanvas is on (CANVAS_PROVIDER_TYPE=duckdb); dataframe-drop also
 * needs PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true. A gated tool is wrapped with
 * disabledTool(), so it stays off tools/list but shows on the landing page with
 * the env var that turns it on. Both gates are read at module load: the
 * framework config is already parsed at package import, and the drop flag is
 * read on its own so a bad value in another server env var fails in setup()
 * behind the startup banner instead of here.
 * @module mcp-server/tools/definitions/index
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { disabledTool } from '@cyanheads/mcp-ts-core/tools';
import { isDataframeDropEnabled } from '@/config/server-config.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { getDiversityTool } from './get-diversity.tool.js';
import { getReferencesTool } from './get-references.tool.js';
import { getTaxonTool } from './get-taxon.tool.js';
import { listIntervalsTool } from './list-intervals.tool.js';
import { searchCollectionsTool } from './search-collections.tool.js';
import { searchOccurrencesTool } from './search-occurrences.tool.js';

const canvasEnabled = config.canvas.providerType !== 'none';

const canvasOff = {
  reason: 'DataCanvas is off in this deployment, so no staged table exists to work with.',
  hint: 'Set CANVAS_PROVIDER_TYPE=duckdb to enable.',
};

const queryTool = canvasEnabled ? dataframeQueryTool : disabledTool(dataframeQueryTool, canvasOff);
const describeTool = canvasEnabled
  ? dataframeDescribeTool
  : disabledTool(dataframeDescribeTool, canvasOff);

const dropTool = !canvasEnabled
  ? disabledTool(dataframeDropTool, {
      reason: canvasOff.reason,
      hint: 'Set CANVAS_PROVIDER_TYPE=duckdb and PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true to enable.',
    })
  : isDataframeDropEnabled()
    ? dataframeDropTool
    : disabledTool(dataframeDropTool, {
        reason: 'Dropping a staged canvas table is off by default in this deployment.',
        hint: 'Set PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true to enable.',
      });

export const allToolDefinitions = [
  searchOccurrencesTool,
  getTaxonTool,
  getDiversityTool,
  listIntervalsTool,
  searchCollectionsTool,
  getReferencesTool,
  queryTool,
  describeTool,
  dropTool,
];
