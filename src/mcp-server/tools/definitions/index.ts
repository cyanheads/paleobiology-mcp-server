/**
 * @fileoverview Tool definitions barrel — assembles allToolDefinitions for createApp().
 *
 * Registers the five domain tools and the DataCanvas trio. The dataframe-drop
 * tool is conditionally registered only when PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true,
 * so the default surface is seven tools (eight with drop enabled).
 * @module mcp-server/tools/definitions/index
 */

import { getServerConfig } from '@/config/server-config.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { getDiversityTool } from './get-diversity.tool.js';
import { getTaxonTool } from './get-taxon.tool.js';
import { listIntervalsTool } from './list-intervals.tool.js';
import { searchCollectionsTool } from './search-collections.tool.js';
import { searchOccurrencesTool } from './search-occurrences.tool.js';

const baseTools = [
  searchOccurrencesTool,
  getTaxonTool,
  getDiversityTool,
  listIntervalsTool,
  searchCollectionsTool,
  dataframeQueryTool,
  dataframeDescribeTool,
];

export const allToolDefinitions = getServerConfig().dataframeDropEnabled
  ? [...baseTools, dataframeDropTool]
  : baseTools;
