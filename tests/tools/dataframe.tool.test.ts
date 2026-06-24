/**
 * @fileoverview Handler tests for the three DataCanvas tools — query, describe,
 * drop. Covers the canvas-enabled happy paths (mocked canvas, no DuckDB),
 * the truncated flag, the dropped=true/false distinction, the empty-tables
 * describe, and the canvas_disabled contract reason for describe and drop
 * (query's canvas_disabled is covered in list-intervals.tool.test.ts).
 *
 * getCanvas() is mocked to a per-test fake; the acquired instance stands in for
 * a real canvas so query()/describe()/drop() are exercised without a provider.
 * @module tests/tools/dataframe.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCanvas = vi.fn();

vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas, setCanvas: () => {} }));

const { dataframeQueryTool } = await import(
  '@/mcp-server/tools/definitions/dataframe-query.tool.js'
);
const { dataframeDescribeTool } = await import(
  '@/mcp-server/tools/definitions/dataframe-describe.tool.js'
);
const { dataframeDropTool } = await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js');

/** A fake DataCanvas whose acquire() returns the supplied instance. */
function fakeCanvas(instance: unknown) {
  return { acquire: vi.fn().mockResolvedValue(instance) };
}

describe('paleobiology_dataframe_query (canvas enabled)', () => {
  beforeEach(() => {
    getCanvas.mockReset();
  });

  it('runs SQL and returns rows + row_count', async () => {
    const instance = {
      canvasId: 'abc1234567',
      query: vi.fn().mockResolvedValue({
        columns: ['formation', 'n'],
        rows: [{ formation: 'Hell Creek', n: 42 }],
        rowCount: 1,
      }),
    };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT formation, COUNT(*) n FROM occurrences_abc1234567 GROUP BY formation',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(dataframeQueryTool.output));
    expect(result.rows).toEqual([{ formation: 'Hell Creek', n: 42 }]);
    expect(result.row_count).toBe(1);
    expect(result.truncated).toBeUndefined();
    expect(instance.query).toHaveBeenCalledWith(input.sql, { signal: ctx.signal });
  });

  it('surfaces the truncated flag when the canvas trims the result', async () => {
    const instance = {
      canvasId: 'abc1234567',
      query: vi.fn().mockResolvedValue({
        columns: ['c'],
        rows: [{ c: 1 }],
        rowCount: 5000,
        truncated: true,
      }),
    };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ canvas_id: 'abc1234567', sql: 'SELECT 1 c' });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(5000);
  });
});

describe('paleobiology_dataframe_describe', () => {
  beforeEach(() => {
    getCanvas.mockReset();
  });

  it('throws canvas_disabled when DataCanvas is off', async () => {
    getCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ canvas_id: 'abc1234567' });
    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('lists tables and columns from the canvas', async () => {
    const instance = {
      canvasId: 'abc1234567',
      describe: vi.fn().mockResolvedValue([
        {
          name: 'occurrences_abc1234567',
          kind: 'table',
          rowCount: 320,
          columns: [
            { name: 'occurrence_no', type: 'BIGINT', nullable: false },
            { name: 'formation', type: 'VARCHAR', nullable: true },
          ],
        },
      ]),
    };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ canvas_id: 'abc1234567' });
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(dataframeDescribeTool.output));
    expect(result.tables[0]).toMatchObject({
      name: 'occurrences_abc1234567',
      kind: 'table',
      row_count: 320,
    });
    expect(result.tables[0]?.columns[0]).toMatchObject({ name: 'occurrence_no', type: 'BIGINT' });
    const text = renderText(dataframeDescribeTool.format?.(result));
    expect(text).toContain('occurrences_abc1234567');
    expect(text).toContain('`occurrence_no` BIGINT');
  });

  it('renders a clear message and valid output when no tables are staged', async () => {
    const instance = { canvasId: 'abc1234567', describe: vi.fn().mockResolvedValue([]) };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ canvas_id: 'abc1234567' });
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(dataframeDescribeTool.output));
    expect(result.tables).toEqual([]);
    expect(renderText(dataframeDescribeTool.format?.(result))).toMatch(/No tables are staged/i);
  });
});

describe('paleobiology_dataframe_drop', () => {
  beforeEach(() => {
    getCanvas.mockReset();
  });

  it('throws canvas_disabled when DataCanvas is off', async () => {
    getCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ canvas_id: 'abc1234567', table_name: 't' });
    await expect(dataframeDropTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('reports dropped=true when the table existed', async () => {
    const instance = { canvasId: 'abc1234567', drop: vi.fn().mockResolvedValue(true) };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({
      canvas_id: 'abc1234567',
      table_name: 'occurrences_abc1234567',
    });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(dataframeDropTool.output));
    expect(result).toEqual({ dropped: true, table_name: 'occurrences_abc1234567' });
    expect(instance.drop).toHaveBeenCalledWith('occurrences_abc1234567');
    expect(renderText(dataframeDropTool.format?.(result))).toMatch(/Dropped table/);
  });

  it('reports dropped=false (not an error) when the table was absent', async () => {
    const instance = { canvasId: 'abc1234567', drop: vi.fn().mockResolvedValue(false) };
    getCanvas.mockReturnValue(fakeCanvas(instance));
    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ canvas_id: 'abc1234567', table_name: 'missing' });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result).toEqual({ dropped: false, table_name: 'missing' });
    expect(renderText(dataframeDropTool.format?.(result))).toMatch(/nothing dropped/i);
  });
});

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
