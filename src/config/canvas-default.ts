/**
 * @fileoverview Defaults DataCanvas on. The entry point imports this module
 * first, before the tool-definitions barrel reads its environment gate.
 * Set CANVAS_PROVIDER_TYPE=none to disable DataCanvas.
 * @module config/canvas-default
 */

import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';

try {
  process.loadEnvFile();
} catch {
  // createApp re-reads .env and reports load failures through its startup boundary.
}
if (normalizeEnv({ canvas: process.env.CANVAS_PROVIDER_TYPE }).canvas === undefined) {
  process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
}
