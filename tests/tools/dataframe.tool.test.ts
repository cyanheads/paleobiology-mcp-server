/**
 * @fileoverview Handler tests for the three DataCanvas tools — query, describe,
 * drop. Covers the canvas-enabled happy paths (mocked canvas, no DuckDB),
 * the truncated flag, complete query rows and the row-cap LIMIT/OFFSET
 * continuation notice, the dropped=true/false distinction, the empty-tables
 * describe, and the canvas_disabled contract reason for describe and drop
 * (query's canvas_disabled is covered in list-intervals.tool.test.ts).
 *
 * getCanvas() is mocked to a per-test fake; the acquired instance stands in for
 * a real canvas so query()/describe()/drop() are exercised without a provider.
 * @module tests/tools/dataframe.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  describe('complete query rows (#40)', () => {
    /** A canvas whose query() answers with these rows, as the DuckDB provider would. */
    function answer(rows: Record<string, unknown>[], extra: { truncated?: boolean } = {}): void {
      getCanvas.mockReturnValue(
        fakeCanvas({
          canvasId: 'abc1234567',
          query: vi.fn().mockResolvedValue({
            columns: Object.keys(rows[0] ?? {}),
            rows,
            rowCount: rows.length,
            ...extra,
          }),
        }),
      );
    }

    /** A staged occurrence row as SELECT * returns it (~680 bytes of JSON). */
    const stagedRow = (i: number) => ({
      occurrence_no: String(i),
      collection_no: '11917',
      identified_name: 'Tyrannosaurus rex',
      identified_rank: 'species',
      accepted_name: 'Tyrannosaurus rex',
      accepted_rank: 'species',
      accepted_no: '54833',
      early_interval: 'Late Maastrichtian',
      late_interval: null,
      max_ma: 72.2,
      min_ma: 66,
      lng: -113.0289,
      lat: 51.9064,
      paleolng: -68.22,
      paleolat: 64.06,
      paleomodel: 'gplates',
      geoplate: '101',
      formation: 'Scollard',
      geological_group: 'Edmonton',
      member: null,
      cc: 'CA',
      state: 'Alberta',
      county: 'Red Deer County',
      classification:
        '{"phylum":"Chordata","class":"Reptilia","order":"Saurischia","family":"Tyrannosauridae","genus":"Tyrannosaurus"}',
      reference_no: '4218',
    });

    it('returns every SELECT * row in order on both surfaces', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => stagedRow(i + 1));
      answer(rows);

      const result = await runToolContract(dataframeQueryTool, {
        canvas_id: 'abc1234567',
        sql: 'SELECT * FROM occurrences_abc1234567',
      });

      const structured = result.structuredContent as {
        rows: Record<string, unknown>[];
        row_count: number;
        truncated?: boolean;
        notice?: string;
      };
      expect(structured.rows).toEqual(rows);
      expect(structured.row_count).toBe(500);
      expect(structured.truncated).toBeUndefined();
      expect(structured.notice).toBeUndefined();
      expect(
        JSON.parse(renderText(result.content as { type: string; text?: string }[])).rows,
      ).toEqual(rows);
    });

    it('says the count stopped at the row cap on a truncated cross join', async () => {
      const rows = Array.from({ length: 10_000 }, (_, i) => ({
        occurrence_no: String(i % 500),
        b_no: String(Math.floor(i / 500)),
      }));
      answer(rows, { truncated: true });

      const result = await runToolContract(dataframeQueryTool, {
        canvas_id: 'abc1234567',
        sql: 'SELECT a.occurrence_no, b.occurrence_no AS b_no FROM t a CROSS JOIN t b',
      });

      const structured = result.structuredContent as {
        rows: unknown[];
        row_count: number;
        truncated: boolean;
        notice: string;
      };
      expect(structured).toMatchObject({ row_count: 10_000, truncated: true });
      expect(structured.notice).toContain(
        'The query produced more than 10000 rows — counting stopped at the 10000-row cap, so row_count is a floor, not the total. Wrap the query in SELECT COUNT(*) FROM (…) for the exact count.',
      );
      expect(structured.rows).toEqual(rows);
      expect(structured.notice).toContain('set LIMIT 10000');
      expect(structured.notice).toContain("raise the query's OFFSET by 10000");
      expect(JSON.stringify(result.content)).toContain('counting stopped at the 10000-row cap');
      expect(renderText(result.content as { type: string; text?: string }[])).toContain(
        'set LIMIT 10000',
      );
    });

    it('preserves a wide row on both surfaces', async () => {
      const rows = [{ occurrence_no: '1', blob: 'x'.repeat(120_000) }];
      answer(rows);

      const result = await runToolContract(dataframeQueryTool, {
        canvas_id: 'abc1234567',
        sql: 'SELECT occurrence_no, repeat(formation, 400) AS blob FROM t',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        rows,
        row_count: 1,
      });
      expect(
        JSON.parse(renderText(result.content as { type: string; text?: string }[])).rows,
      ).toEqual(rows);
    });

    it('adds no notice when the whole result fits', async () => {
      answer([{ formation: 'Hell Creek', n: 42 }]);

      const result = await runToolContract(dataframeQueryTool, {
        canvas_id: 'abc1234567',
        sql: 'SELECT formation, COUNT(*) n FROM t GROUP BY formation',
      });

      expect(result.structuredContent).toEqual({
        rows: [{ formation: 'Hell Creek', n: 42 }],
        row_count: 1,
      });
    });
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

describe('canvas_id input shape', () => {
  const required = [
    ['paleobiology_dataframe_query', dataframeQueryTool, { sql: 'SELECT 1' }],
    ['paleobiology_dataframe_describe', dataframeDescribeTool, {}],
    ['paleobiology_dataframe_drop', dataframeDropTool, { table_name: 't' }],
  ] as const;

  /*
   * Every canvas_id INPUT is declared with CanvasIdSchema, so the minted
   * ^[A-Za-z0-9_-]{10}$ shape is advertised in inputSchema and an impossible
   * value is rejected at argument validation — the handler never runs, and the
   * canvas registry's canvas_id_malformed never fires on these tools.
   */
  for (const [name, def, rest] of required) {
    it(`${name} accepts a minted id and rejects a malformed one`, () => {
      expect(def.input.parse({ canvas_id: 'aB3_x-9Zq0', ...rest }).canvas_id).toBe('aB3_x-9Zq0');
      for (const bad of ['x', 'toolongcanvasid', 'abc123456!']) {
        expect(() => def.input.parse({ canvas_id: bad, ...rest })).toThrow();
      }
    });
  }

  it('paleobiology_search_occurrences constrains canvas_id while keeping it optional', async () => {
    const { searchOccurrencesTool } = await import(
      '@/mcp-server/tools/definitions/search-occurrences.tool.js'
    );
    expect(
      searchOccurrencesTool.input.parse({ base_name: 'Dinosauria' }).canvas_id,
    ).toBeUndefined();
    expect(() =>
      searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', canvas_id: 'nope' }),
    ).toThrow();
  });
});

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
