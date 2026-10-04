/**
 * @fileoverview Occurrence staging through the real DuckDB canvas and tool contracts.
 * The upstream search boundary supplies deterministic rows; staging, SQL,
 * schema validation, formatting, and canvas cleanup all run unmocked.
 * @module tests/tools/occurrence-canvas
 */

import {
  CanvasIdSchema,
  CanvasRegistry,
  DataCanvas,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { searchOccurrencesTool } from '@/mcp-server/tools/definitions/search-occurrences.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import * as pbdb from '@/services/pbdb/pbdb-service.js';
import type { Occurrence } from '@/services/pbdb/types.js';

let canvas: DataCanvas;
const context = createMockContext();

beforeEach(() => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '.cache/canvas-test-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(provider, new CanvasRegistry(provider));
  setCanvas(canvas);
  pbdb.initPbdbService(parseConfig());
});

afterEach(async () => {
  setCanvas(undefined);
  vi.restoreAllMocks();
  await canvas.shutdown(context);
});

it('preserves fractional ages and coordinates after an integral preview', async () => {
  const rows: Occurrence[] = Array.from({ length: 500 }, (_, i) => ({
    occurrence_no: i + 1,
    formation: 'X'.repeat(1000),
    max_ma: 70,
    min_ma: 66,
    lng: -110,
    lat: 45,
  }));
  rows[499] = { ...rows[499], occurrence_no: 500, min_ma: 66.25, lng: -110.75, lat: 45.125 };
  vi.spyOn(pbdb.getPbdbService(), 'searchOccurrences').mockImplementation(() => ({
    rows: (async function* () {
      yield* rows;
    })(),
    meta: { recordsFound: rows.length },
  }));

  const staged = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 500,
  });
  expect(staged.isError).not.toBe(true);
  const handle = searchOccurrencesTool.output.parse(staged.structuredContent);
  expect(handle.spilled).toBe(true);
  expect(handle.row_count).toBe(500);
  const queried = await runToolContract(dataframeQueryTool, {
    canvas_id: CanvasIdSchema.parse(handle.canvas_id),
    sql: `SELECT min_ma, lng, lat FROM ${handle.table_name} WHERE occurrence_no = 500`,
  });
  expect(queried.isError).not.toBe(true);
  expect(queried.structuredContent).toMatchObject({
    rows: [{ min_ma: 66.25, lng: -110.75, lat: 45.125 }],
  });
  expect(JSON.stringify(queried.content)).toContain('66.25');
});

it('retains sparse columns and nested classification first populated after the preview', async () => {
  const rows: Occurrence[] = Array.from({ length: 500 }, (_, i) => ({
    occurrence_no: i + 1,
    formation: 'X'.repeat(1000),
  }));
  rows[499] = {
    occurrence_no: 500,
    paleolng: -68.22,
    paleolat: 64.06,
    classification: { family: 'Tyrannosauridae', genus: 'Tyrannosaurus' },
    reference_no: 149,
  };
  vi.spyOn(pbdb.getPbdbService(), 'searchOccurrences').mockImplementation(() => ({
    rows: (async function* () {
      yield* rows;
    })(),
    meta: { recordsFound: rows.length },
  }));
  const staged = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 500,
  });
  expect(staged.isError).not.toBe(true);
  const handle = searchOccurrencesTool.output.parse(staged.structuredContent);
  expect(handle.spilled).toBe(true);
  const described = await runToolContract(dataframeDescribeTool, {
    canvas_id: CanvasIdSchema.parse(handle.canvas_id),
  });
  expect(described.structuredContent).toMatchObject({
    tables: [
      {
        columns: expect.arrayContaining([
          { name: 'max_ma', type: 'DOUBLE', nullable: true },
          { name: 'classification', type: 'JSON', nullable: true },
        ]),
      },
    ],
  });
  expect(JSON.stringify(described.content)).toContain('DOUBLE');
  const queried = await runToolContract(dataframeQueryTool, {
    canvas_id: CanvasIdSchema.parse(handle.canvas_id),
    sql: `SELECT paleolng, paleolat, json_extract_string(classification, '$.family') AS family, reference_no FROM ${handle.table_name} WHERE occurrence_no = 500`,
  });
  expect(queried.isError).not.toBe(true);
  expect(queried.structuredContent).toMatchObject({
    rows: [{ paleolng: -68.22, paleolat: 64.06, family: 'Tyrannosauridae', reference_no: '149' }],
  });
  expect(JSON.stringify(queried.content)).toContain('Tyrannosauridae');
  const absent = await runToolContract(dataframeQueryTool, {
    canvas_id: CanvasIdSchema.parse(handle.canvas_id),
    sql: `SELECT paleolng, classification, reference_no FROM ${handle.table_name} WHERE occurrence_no = 1`,
  });
  expect(absent.structuredContent).toMatchObject({
    rows: [{ paleolng: null, classification: null, reference_no: null }],
  });
  const dropInput = dataframeDropTool.input.parse({
    canvas_id: handle.canvas_id,
    table_name: handle.table_name,
  });
  const dropped = await runToolContract(dataframeDropTool, dropInput);
  expect(dropped.structuredContent).toMatchObject({ dropped: true });
  expect(JSON.stringify(dropped.content)).toContain('Dropped table');
  const droppedAgain = await runToolContract(dataframeDropTool, dropInput);
  expect(droppedAgain.structuredContent).toMatchObject({ dropped: false });
});

it('puts declared canvas-disabled recovery on both client surfaces', async () => {
  setCanvas(undefined);
  const calls = [
    runToolContract(dataframeDescribeTool, { canvas_id: 'abc1234567' }),
    runToolContract(dataframeQueryTool, { canvas_id: 'abc1234567', sql: 'SELECT 1' }),
    runToolContract(dataframeDropTool, { canvas_id: 'abc1234567', table_name: 'occurrences' }),
  ];
  for (const result of await Promise.all(calls)) {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'canvas_disabled',
          recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  }
});
