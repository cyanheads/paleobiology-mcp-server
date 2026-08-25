/**
 * @fileoverview Tool definitions barrel — assembles allToolDefinitions for createApp().
 *
 * Registers the five domain tools and the DataCanvas trio. The dataframe-drop
 * tool is callable only when PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true; while the
 * flag is off it is wrapped with disabledTool(), so it stays off tools/list but
 * shows on the manifest and landing page with the env var that turns it on.
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool } from '@cyanheads/mcp-ts-core/tools';
import { getServerConfig } from '@/config/server-config.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { getDiversityTool } from './get-diversity.tool.js';
import { getTaxonTool } from './get-taxon.tool.js';
import { listIntervalsTool } from './list-intervals.tool.js';
import { searchCollectionsTool } from './search-collections.tool.js';
import { searchOccurrencesTool } from './search-occurrences.tool.js';

const dropTool = getServerConfig().dataframeDropEnabled
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
  dataframeQueryTool,
  dataframeDescribeTool,
  dropTool,
];
