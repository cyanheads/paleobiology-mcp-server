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
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { searchOccurrencesTool } from '@/mcp-server/tools/definitions/search-occurrences.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import * as pbdb from '@/services/pbdb/pbdb-service.js';
import type { Occurrence, PbdbSearchMeta } from '@/services/pbdb/types.js';

let canvas: DataCanvas;
const context = createMockContext();

/** A real DuckDB canvas, optionally capped at `maxCanvasesPerTenant`. */
function makeCanvas(maxCanvasesPerTenant?: number): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '.cache/canvas-test-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  const registry =
    maxCanvasesPerTenant === undefined
      ? new CanvasRegistry(provider)
      : new CanvasRegistry(provider, {
          ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
          maxCanvasesPerTenant,
          sweeperIntervalMs: 0,
        });
  return new DataCanvas(provider, registry);
}

/** Swap the suite canvas for one capped at `max` canvases per tenant. */
async function capCanvasesAt(max: number): Promise<void> {
  await canvas.shutdown(context);
  canvas = makeCanvas(max);
  setCanvas(canvas);
}

/** Answer every occurrence search with these rows and upstream metadata. */
function serve(rows: Occurrence[], meta: PbdbSearchMeta = { recordsFound: rows.length }): void {
  vi.spyOn(pbdb.getPbdbService(), 'searchOccurrences').mockImplementation(async () => ({
    rows,
    meta,
  }));
}

/** Run a 500-row search that spills; returns its parsed handle and canvas id. */
async function stageSpill() {
  serve(wideRows(500));
  const handle = searchOccurrencesTool.output.parse(
    (await runToolContract(searchOccurrencesTool, { base_name: 'Dinosauria', limit: 500 }))
      .structuredContent,
  );
  return { handle, canvasId: CanvasIdSchema.parse(handle.canvas_id) };
}

/** Run SQL on a canvas through dataframe_query; returns its structuredContent. */
async function query<Row>(canvasId: string, sql: string) {
  return (await runToolContract(dataframeQueryTool, { canvas_id: canvasId, sql }))
    .structuredContent as { rows: Row[]; row_count: number; notice?: string };
}

/** Rows wide enough that 500 of them overflow the inline budget and spill. */
const wideRows = (count: number): Occurrence[] =>
  Array.from({ length: count }, (_, i) => ({
    occurrence_no: i + 1,
    formation: 'X'.repeat(1000),
    max_ma: 70,
    min_ma: 66,
  }));

const fiveRexes: Occurrence[] = Array.from({ length: 5 }, (_, i) => ({
  occurrence_no: 139292 + i,
  accepted_name: 'Tyrannosaurus rex',
  max_ma: 72.2,
  min_ma: 66,
}));

beforeEach(() => {
  canvas = makeCanvas();
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
  serve(rows);

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
  serve(rows);
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

describe('canvas slots (#32)', () => {
  it('holds no canvas slot for pages that fit inline, even at a cap of 1', async () => {
    await capCanvasesAt(1);
    serve(fiveRexes, { recordsFound: 22 });

    for (let call = 0; call < 2; call++) {
      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Tyrannosaurus',
        limit: 5,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ spilled: false, row_count: 5 });
    }
    expect(canvas.countForTenant(context)).toBe(0);
  });

  it('mints no canvas for a zero-match call or a failed upstream request', async () => {
    await capCanvasesAt(1);
    serve([], { recordsFound: 0 });
    const empty = await runToolContract(searchOccurrencesTool, {
      base_name: 'Tyrannosaurus',
      interval: 'Cambrian',
    });
    expect(empty.structuredContent).toMatchObject({ row_count: 0 });

    vi.spyOn(pbdb.getPbdbService(), 'searchOccurrences').mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB is unavailable (HTTP 503).'),
    );
    const failed = await runToolContract(searchOccurrencesTool, { base_name: 'Tyrannosaurus' });
    expect(failed.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable },
    });
    expect(canvas.countForTenant(context)).toBe(0);

    // The one slot is still free: a spilling page mints exactly one canvas.
    serve(wideRows(500), { recordsFound: 4170 });
    const spilled = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
    });
    expect(spilled.isError).toBeFalsy();
    const handle = searchOccurrencesTool.output.parse(spilled.structuredContent);
    expect(handle).toMatchObject({ spilled: true, row_count: 500 });
    expect(handle.table_name).toBe(`occurrences_${handle.canvas_id?.replace(/-/g, '_')}`);
    expect(canvas.countForTenant(context)).toBe(1);
  });

  it('leaves no canvas behind when staging fails after a fresh mint', async () => {
    await capCanvasesAt(1);
    const rows = wideRows(500);
    rows[499] = { ...rows[499], occurrence_no: null as never };
    serve(rows);

    const failed = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.structuredContent)).toContain('NOT NULL');
    expect(canvas.countForTenant(context)).toBe(0);

    serve(wideRows(500));
    const retried = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
    });
    expect(retried.isError).toBeFalsy();
    expect(canvas.countForTenant(context)).toBe(1);
  });

  it('touches a caller-supplied canvas only when the page spills', async () => {
    const { handle: first, canvasId } = await stageSpill();

    serve(fiveRexes);
    const inline = await runToolContract(searchOccurrencesTool, {
      base_name: 'Tyrannosaurus',
      limit: 5,
      canvas_id: canvasId,
    });
    expect(inline.structuredContent).toMatchObject({ spilled: false, row_count: 5 });
    expect(inline.structuredContent).not.toHaveProperty('canvas_id');
    const untouched = await query(canvasId, `SELECT COUNT(*) AS n FROM ${first.table_name}`);
    expect(untouched).toMatchObject({ rows: [{ n: '500' }] });

    // A stale id passed with an inline page is never looked up (a lookup would fail it).
    const stale = await runToolContract(searchOccurrencesTool, {
      base_name: 'Tyrannosaurus',
      limit: 5,
      canvas_id: 'zzzzzzzzzz',
    });
    expect(stale.isError).toBeFalsy();
    expect(stale.structuredContent).toMatchObject({ spilled: false, row_count: 5 });

    serve(wideRows(300));
    const replaced = searchOccurrencesTool.output.parse(
      (
        await runToolContract(searchOccurrencesTool, {
          base_name: 'Dinosauria',
          limit: 300,
          canvas_id: canvasId,
        })
      ).structuredContent,
    );
    expect(replaced).toMatchObject({ spilled: true, canvas_id: canvasId, row_count: 300 });
    const recount = await query(canvasId, `SELECT COUNT(*) AS n FROM ${replaced.table_name}`);
    expect(recount).toMatchObject({ rows: [{ n: '300' }] });
    expect(canvas.countForTenant(context)).toBe(1);
  });

  it('settles a cancelled spill as cancelled, never as a degraded success', async () => {
    serve(wideRows(500));
    const controller = new AbortController();
    controller.abort();

    const result = await runToolContract(
      searchOccurrencesTool,
      { base_name: 'Dinosauria', limit: 500 },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(canvas.countForTenant(context)).toBe(0);
  });
});

describe('dataframe_query continuation (#23)', () => {
  it('walks a budget-cut SELECT * by the LIMIT/OFFSET its notice names, until the stop its notice names', async () => {
    const { handle, canvasId } = await stageSpill();
    const ordered = `SELECT * FROM ${handle.table_name} ORDER BY occurrence_no`;
    const run = (sql: string) => query<{ occurrence_no: string }>(canvasId, sql);

    const first = await run(ordered);
    expect(first.row_count).toBe(500);
    const limit = Number(/set LIMIT (\d+)/.exec(first.notice ?? '')?.[1]);
    expect(limit).toBe(first.rows.length);
    expect(first.notice).toContain(`(OFFSET ${limit} if it has none)`);
    // The walk ends on the rule the notice states, not on a convention the test assumes.
    const stopBelow = Number(
      /until a page returns fewer than (\d+) rows/.exec(first.notice ?? '')?.[1],
    );
    expect(stopBelow).toBe(limit);

    const seen = first.rows.map((r) => r.occurrence_no);
    let offset = limit;
    let pages = 1;
    for (;;) {
      const page = await run(`${ordered} LIMIT ${limit} OFFSET ${offset}`);
      seen.push(...page.rows.map((r) => r.occurrence_no));
      pages += 1;
      const raise = /raise the query's OFFSET by (\d+)/.exec(page.notice ?? '')?.[1];
      if (raise) {
        offset += Number(raise);
        continue;
      }
      if (page.rows.length < stopBelow) break;
      offset += page.rows.length;
    }
    expect(pages).toBeGreaterThan(2);

    const direct = await run(
      `SELECT occurrence_no FROM ${handle.table_name} ORDER BY occurrence_no`,
    );
    expect(direct.notice).toBeUndefined();
    expect(seen).toEqual(direct.rows.map((r) => r.occurrence_no));
  });

  it("ends a walk over a query with its own LIMIT at that query's window", async () => {
    const { handle, canvasId } = await stageSpill();
    const ordered = `SELECT * FROM ${handle.table_name} ORDER BY occurrence_no`;
    const run = (sql: string) => query<{ occurrence_no: string }>(canvasId, sql);

    const first = await run(`${ordered} LIMIT 300 OFFSET 50`);
    const shown = first.rows.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(300);
    expect(first.notice).toContain(
      `raise the query's OFFSET by ${shown} (OFFSET ${shown} if it has none) for each next page, ` +
        `until a page returns fewer than ${shown} rows. If the query had its own LIMIT, stop once ` +
        "the pages read add up to it, lowering the last page's LIMIT to the rows that remain.",
    );

    // Follow the notice: pages of `shown` from OFFSET 50 + shown, the last one lowered.
    const seen = first.rows.map((r) => r.occurrence_no);
    let offset = 50 + shown;
    while (seen.length < 300) {
      const page = await run(
        `${ordered} LIMIT ${Math.min(shown, 300 - seen.length)} OFFSET ${offset}`,
      );
      seen.push(...page.rows.map((r) => r.occurrence_no));
      offset += page.rows.length;
    }
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => String(51 + i)));
  });
});

describe('canvas cap recovery (#35)', () => {
  const CAP_RECOVERY =
    'Pass a canvas_id you already hold to restage this page onto that canvas, replacing its occurrence table, or lower limit so the page fits inline and stages nothing (the message names a limit that fits).';

  it('names only levers that work here when a spilling page meets the canvas cap', async () => {
    await capCanvasesAt(1);
    const { handle: held, canvasId } = await stageSpill();
    const fits = held.occurrences.length;
    expect(canvas.countForTenant(context)).toBe(1);

    serve(wideRows(500));
    const refused = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        message: `No canvas slot is free to stage this page: the active canvas cap is reached. A limit of ${fits} or less fits this page inline.`,
        data: {
          reason: 'canvas_capacity_exhausted',
          retryable: true,
          recovery: { hint: CAP_RECOVERY },
        },
      },
    });
    const text = (refused.content as { text: string }[]).map((c) => c.text).join('\n');
    expect(text).toContain(`Recovery: ${CAP_RECOVERY}`);
    expect(text).toContain('reason canvas_capacity_exhausted');
    const wire = JSON.stringify(refused);
    expect(wire).not.toContain('canvas-drop tool');
    expect(wire).not.toContain('dataframe_drop');
    expect(canvas.countForTenant(context)).toBe(1);

    // Lever 1: the held canvas_id restages onto that canvas — no new slot.
    serve(wideRows(500));
    const restaged = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
      canvas_id: canvasId,
    });
    expect(restaged.isError).toBeFalsy();
    expect(restaged.structuredContent).toMatchObject({
      spilled: true,
      canvas_id: canvasId,
      row_count: 500,
    });

    // Lever 2: the limit the message names fits inline and stages nothing.
    serve(wideRows(fits), { recordsFound: 500 });
    const inline = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: fits,
    });
    expect(inline.isError).toBeFalsy();
    expect(inline.structuredContent).toMatchObject({ spilled: false, row_count: fits });
    expect(canvas.countForTenant(context)).toBe(1);
  });

  it('declares the reason on the tool contract under the framework code', () => {
    const entry = searchOccurrencesTool.errors?.find(
      (e) => e.reason === 'canvas_capacity_exhausted',
    );
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      recovery: CAP_RECOVERY,
    });
    expect(entry).not.toHaveProperty('thrownBy');
  });
});

it('reports a missing canvas on drop as nothing to drop, not a re-stage', async () => {
  const result = await runToolContract(dataframeDropTool, {
    canvas_id: CanvasIdSchema.parse('abcdefghij'),
    table_name: 'occurrences_abcdefghij',
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'canvas_not_found',
        recovery: {
          hint: 'The canvas has expired or never existed, so there is nothing left to drop. If you expected it to be live, check that the canvas_id was copied exactly.',
        },
      },
    },
  });
  expect(JSON.stringify(result.content)).toContain('nothing left to drop');
  expect(JSON.stringify(result)).not.toContain('Re-run the tool');
  const entry = dataframeDropTool.errors?.find((e) => e.reason === 'canvas_not_found');
  expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound });
  expect(entry).not.toHaveProperty('thrownBy');
});
