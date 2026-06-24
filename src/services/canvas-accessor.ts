/**
 * @fileoverview Module-level DataCanvas accessor for the occurrence spill path.
 * The framework wires the optional canvas onto CoreServices in setup(); handlers
 * reach it through this accessor. Undefined when CANVAS_PROVIDER_TYPE !== duckdb.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Wire the canvas from setup(core). Pass core.canvas (may be undefined). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Resolve the canvas, or undefined when DataCanvas is disabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
