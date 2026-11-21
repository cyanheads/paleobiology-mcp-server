/**
 * @fileoverview Inline PBDB page limits through the real service and tool contracts.
 * @module tests/tools/search-page-limits
 */

import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  createMockLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCollectionsTool } from '@/mcp-server/tools/definitions/search-collections.tool.js';
import { searchOccurrencesTool } from '@/mcp-server/tools/definitions/search-occurrences.tool.js';
import { resolveSearchLimit } from '@/mcp-server/tools/paging.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initPbdbService } from '@/services/pbdb/pbdb-service.js';

const { addClamp } = vi.hoisted(() => ({ addClamp: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...args: Parameters<typeof actual.createCounter>) =>
      args[0] === 'paleobiology.search.limit_clamped'
        ? { add: addClamp }
        : actual.createCounter(...args),
  };
});

const tools = [
  { tool: searchCollectionsTool, output: 'collections', id: 'collection_no', noun: 'localities' },
  { tool: searchOccurrencesTool, output: 'occurrences', id: 'occurrence_no', noun: 'occurrences' },
] as const;

function rendered(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe.each(tools)('$tool.name inline page limits', ({ tool, output, id, noun }) => {
  const fetchPage = vi.fn<(url: URL) => Promise<Response>>();

  beforeEach(() => {
    vi.stubEnv('PBDB_MAX_OCCURRENCES', '3');
    vi.stubGlobal('fetch', fetchPage);
    fetchPage.mockReset();
    addClamp.mockClear();
    initPbdbService(parseConfig());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function serve(total: number): void {
    fetchPage.mockImplementation(async (url) => {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const records = Array.from({ length: total }, (_, index) => ({ [id]: 101 + index }));
      return Response.json({
        records_found: total,
        records: records.slice(offset, offset + limit),
      });
    });
  }

  it('advances by delivered rows and stops on the final page within the request ceiling', async () => {
    serve(7);
    const first = await runToolContract(tool, { base_name: 'Dinosauria', limit: 3, offset: 2 });
    expect(first.structuredContent).toMatchObject({
      [output]: [{ [id]: 103 }, { [id]: 104 }, { [id]: 105 }],
      notice: expect.stringContaining('Advance offset to 5 for the next page.'),
    });
    expect(rendered(first)).toContain('Advance offset to 5 for the next page.');

    const last = await runToolContract(tool, { base_name: 'Dinosauria', limit: 3, offset: 5 });
    expect(last.structuredContent).toMatchObject({ [output]: [{ [id]: 106 }, { [id]: 107 }] });
    expect(last.structuredContent).not.toHaveProperty('notice');
    expect(rendered(last)).not.toContain('next page');
    expect(addClamp).not.toHaveBeenCalled();
  });

  it('serves an over-ceiling request at the operator cap and discloses it on an empty page', async () => {
    serve(2);
    const result = await runToolContract(tool, {
      base_name: 'Dinosauria',
      limit: 10001,
      offset: 3,
    });

    const guidance = `limit 10001 is above the per-call cap of 3, so this page drew from at most 3 ${noun}.`;
    expect(result.isError).toBeFalsy();
    expect(fetchPage.mock.calls[0]?.[0].searchParams.get('limit')).toBe('3');
    expect(result.structuredContent).toMatchObject({
      [output]: [],
      notice: expect.stringContaining(guidance),
    });
    expect(rendered(result)).toContain(guidance);
    expect(rendered(result)).not.toContain('next page');
    expect(addClamp).toHaveBeenCalledExactlyOnceWith(1, { tool: tool.name });
  });

  it.each([0, -1, 1.5])('rejects invalid limit %s before counting or fetching', async (limit) => {
    const result = await runToolContract(tool, { base_name: 'Dinosauria', limit });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(rendered(result)).toContain('limit');
    expect(fetchPage).not.toHaveBeenCalled();
    expect(addClamp).not.toHaveBeenCalled();
  });

  it('preserves the missing-filter recovery without counting a clamp', async () => {
    const result = await runToolContract(tool, { limit: 10001 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'missing_filter',
          recovery: { hint: expect.stringContaining('Provide at least one filter') },
        },
      },
    });
    expect(rendered(result)).toContain('Provide at least one filter');
    expect(fetchPage).not.toHaveBeenCalled();
    expect(addClamp).not.toHaveBeenCalled();
  });

  it('discloses the cap on a page with more rows and again on the final page', async () => {
    serve(5);
    const guidance = `limit 10001 is above the per-call cap of 3, so this page drew from at most 3 ${noun}.`;
    const result = await runToolContract(tool, { base_name: 'Dinosauria', limit: 10001 });
    expect(result.structuredContent).toMatchObject({
      [output]: [{ [id]: 101 }, { [id]: 102 }, { [id]: 103 }],
      notice: expect.stringContaining(guidance),
    });
    expect(rendered(result)).toContain('Advance offset to 3 for the next page.');
    expect(rendered(result)).toContain(guidance);

    const last = await runToolContract(tool, { base_name: 'Dinosauria', limit: 10001, offset: 3 });
    expect(last.structuredContent).toMatchObject({
      [output]: [{ [id]: 104 }, { [id]: 105 }],
      notice: expect.stringContaining(guidance),
    });
    expect(rendered(last)).toContain(guidance);
    expect(rendered(last)).not.toContain('next page');
    expect(addClamp.mock.calls).toEqual([
      [1, { tool: tool.name }],
      [1, { tool: tool.name }],
    ]);
  });
});

it('logs and counts each actual clamp once', () => {
  addClamp.mockClear();
  const log = createMockLogger();
  const ctx = { ...createMockContext(), log };
  resolveSearchLimit('paleobiology_search_occurrences', 3, ctx);
  expect(log.calls).toEqual([]);
  expect(addClamp).not.toHaveBeenCalled();

  resolveSearchLimit('paleobiology_search_occurrences', 10001, ctx);
  expect(log.calls).toEqual([
    {
      level: 'info',
      msg: 'PBDB search limit clamped',
      data: { tool: 'paleobiology_search_occurrences', requested: 10001, effective: 3 },
    },
  ]);
  expect(addClamp).toHaveBeenCalledExactlyOnceWith(1, { tool: 'paleobiology_search_occurrences' });
});

it('clamps a staged occurrence search once and fetches the staging set independently', async () => {
  vi.stubEnv('PBDB_MAX_OCCURRENCES', '3');
  const records = Array.from({ length: 5 }, (_, index) => ({ occurrence_no: 201 + index }));
  const fetchPage = vi.fn<(url: URL) => Promise<Response>>(async (url) =>
    Response.json({
      records_found: 5,
      records: records.slice(0, Number(url.searchParams.get('limit'))),
    }),
  );
  vi.stubGlobal('fetch', fetchPage);
  const registerTable = vi.fn(async (tableName: string, rows: unknown[]) => ({
    tableName,
    rowCount: rows.length,
  }));
  setCanvas({ acquire: async () => ({ canvasId: 'clamp00001', registerTable }) } as never);
  initPbdbService(parseConfig());
  addClamp.mockClear();
  try {
    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 10001,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      occurrences: records.slice(0, 3),
      spilled: true,
      row_count: 5,
      notice: expect.stringContaining('limit 10001 is above the per-call cap of 3'),
    });
    expect(rendered(result)).toContain('Staged 5 matching occurrences');
    expect(rendered(result)).toContain('limit 10001 is above the per-call cap of 3');
    expect(rendered(result)).toContain('Advance offset to 3');
    expect(registerTable).toHaveBeenCalledExactlyOnceWith(
      'occurrences_clamp00001',
      records,
      expect.anything(),
    );
    expect(addClamp).toHaveBeenCalledExactlyOnceWith(1, {
      tool: 'paleobiology_search_occurrences',
    });
    expect(
      fetchPage.mock.calls.map(([url]) => [
        url.searchParams.get('limit'),
        url.searchParams.get('offset'),
      ]),
    ).toEqual([
      ['3', '0'],
      ['50000', '0'],
    ]);
  } finally {
    setCanvas(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it.each(['true', 'false'])(
  'honors the 10,000 ceiling with clamping %s and a higher deployment cap',
  async (mode) => {
    vi.resetModules();
    vi.stubEnv('PBDB_CLAMP_LIMITS', mode);
    vi.stubEnv('PBDB_MAX_OCCURRENCES', '12000');
    const fetchPage = vi.fn<(url: URL) => Promise<Response>>(async () =>
      Response.json({ records_found: 0, records: [] }),
    );
    vi.stubGlobal('fetch', fetchPage);
    addClamp.mockClear();
    try {
      const [
        { searchCollectionsTool: collections },
        { searchOccurrencesTool: occurrences },
        service,
      ] = await Promise.all([
        import('@/mcp-server/tools/definitions/search-collections.tool.js'),
        import('@/mcp-server/tools/definitions/search-occurrences.tool.js'),
        import('@/services/pbdb/pbdb-service.js'),
      ]);
      service.initPbdbService(parseConfig());
      for (const tool of [collections, occurrences]) {
        const result = await runToolContract(tool, { base_name: 'Dinosauria', limit: 10001 });
        if (mode === 'true') {
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            notice: expect.stringContaining('limit 10001 is above the per-call cap of 10000'),
          });
          expect(rendered(result)).toContain('limit 10001 is above the per-call cap of 10000');
        } else {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.InvalidParams,
              message: expect.stringContaining('limit: Too big: expected number to be <=10000'),
            },
          });
          expect(rendered(result)).toContain('10000');
        }
      }
      if (mode === 'true') {
        expect(fetchPage.mock.calls.map(([url]) => url.searchParams.get('limit'))).toEqual([
          '10000',
          '10000',
        ]);
        expect(addClamp.mock.calls).toEqual([
          [1, { tool: collections.name }],
          [1, { tool: occurrences.name }],
        ]);
      } else {
        expect(fetchPage).not.toHaveBeenCalled();
        expect(addClamp).not.toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
