#!/usr/bin/env node
/**
 * @fileoverview paleobiology-mcp-server MCP server entry point.
 *
 * Fossil biodiversity over the Paleobiology Database (PBDB) — occurrences,
 * taxon ranges, diversity through time, the geologic time scale, and fossil
 * localities. Keyless, CC BY. Wires the PBDB client, the bundled geologic
 * time-scale index, and the optional DataCanvas spill path in setup().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initIntervalIndex } from './services/intervals/interval-index.js';
import { initPbdbService } from './services/pbdb/pbdb-service.js';

await createApp({
  name: 'paleobiology-mcp-server',
  title: 'paleobiology-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  /**
   * No handler calls ctx.requestInput and nothing is held between calls — the
   * interval index and PBDB client are process-wide, and a staged occurrence set
   * lives on the tenant-scoped canvas, not in a session. Declared here rather
   * than left to the MCP_SESSION_MODE schema default (auto → stateful), so a
   * source run resolves the same mode the Dockerfile pins. A deployment can
   * still override with a meaningful MCP_SESSION_MODE.
   */
  sessionMode: 'stateless',
  instructions:
    'Fossil biodiversity over the Paleobiology Database (PBDB) across ~540 million years. ' +
    'Resolve a taxon name to its accepted name + integer taxon_no with paleobiology_get_taxon ' +
    'before occurrence or diversity searches. Geologic time is the native axis: every temporal ' +
    'filter accepts a named interval (e.g. "Maastrichtian") or a max_ma/min_ma range, and every ' +
    'result echoes both — use paleobiology_list_intervals to translate between them. Each ' +
    'occurrence carries two distinct coordinate systems: modern lng/lat (where the rock sits ' +
    'today) and paleo lng/lat (where the landmass sat at deposition) — never conflate them. ' +
    'Sparse fields (paleo-coords, formation, late_interval) are omitted when PBDB lacks them, ' +
    'not zeroed. Diversity counts reflect sampled diversity, biased by collection effort. ' +
    'Data is from the Paleobiology Database (paleobiodb.org), licensed CC BY 4.0 — credit it ' +
    'in downstream use.',
  setup(core) {
    initIntervalIndex();
    initPbdbService(core.config);
    setCanvas(core.canvas);
  },
});
