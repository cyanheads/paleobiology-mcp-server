/** @fileoverview Row-complete output, bounded occurrence staging, and filter wiring. */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, expect, it, vi } from 'vitest';

const searchOccurrences = vi.fn();
const searchOccurrenceSet = vi.fn();
const searchCollections = vi.fn();
const acquire = vi.fn();
const registerTable = vi.fn();
const drop = vi.fn();
const query = vi.fn();
let enabled = false;
vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => ({
  ...(await importActual<typeof import('@/services/pbdb/pbdb-service.js')>()),
  MAX_STAGED_OCCURRENCES: 50_000,
  getPbdbService: () => ({ searchOccurrences, searchOccurrenceSet, searchCollections }),
}));
vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => (enabled ? { acquire, drop } : undefined),
}));
const { searchOccurrencesTool } = await import(
  '@/mcp-server/tools/definitions/search-occurrences.tool.js'
);
const { searchCollectionsTool } = await import(
  '@/mcp-server/tools/definitions/search-collections.tool.js'
);
const { dataframeQueryTool } = await import(
  '@/mcp-server/tools/definitions/dataframe-query.tool.js'
);
const rows = Array.from({ length: 600 }, (_, occurrence_no) => ({
  occurrence_no,
  formation: 'F'.repeat(1000),
}));
beforeEach(() => {
  vi.resetAllMocks();
  enabled = false;
  drop.mockResolvedValue(true);
  searchOccurrences.mockResolvedValue({ rows, meta: { recordsFound: 700 } });
  searchOccurrenceSet.mockResolvedValue({
    rows: [...rows, { occurrence_no: 700 }],
    meta: { recordsFound: 601 },
  });
  searchCollections.mockResolvedValue({
    collections: rows.map((r) => ({ collection_no: r.occurrence_no, formation: r.formation })),
    shown: 600,
    total: 700,
    truncated: true,
    offset: 0,
    cap: 600,
  });
  registerTable.mockImplementation(async (tableName, data) => ({
    tableName,
    rowCount: data.length,
  }));
  acquire.mockResolvedValue({ canvasId: 'abcdefghij', isNew: false, registerTable, drop });
});
it('characterizes true totals and offset continuation without canvas', async () => {
  searchOccurrences.mockResolvedValue({ rows: [{ occurrence_no: 1 }], meta: { recordsFound: 3 } });
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 1,
    offset: 1,
  });
  expect(result.structuredContent).toMatchObject({
    totalCount: 3,
    row_count: 1,
    spilled: false,
    notice: expect.stringContaining('offset to 2'),
  });
});
it('returns the entire caller-selected occurrence page on both surfaces', async () => {
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 600,
  });
  expect(result.structuredContent).toMatchObject({ row_count: 600, occurrences: rows });
  expect(JSON.stringify(result.content)).toContain('**occurrence_no:** 599');
  expect(searchOccurrences.mock.calls[0]?.[0].limit).toBe(600);
});
it('returns all collection and dataframe rows without byte cutting', async () => {
  const result = await runToolContract(searchCollectionsTool, {
    formation: 'Hell Creek',
    limit: 600,
  });
  expect((result.structuredContent as { collections: unknown[] }).collections).toHaveLength(600);
  enabled = true;
  acquire.mockResolvedValue({ query });
  query.mockResolvedValue({ rows, rowCount: 600 });
  const sql = await runToolContract(dataframeQueryTool, {
    canvas_id: 'abcdefghij',
    sql: 'SELECT * FROM fossils',
  });
  expect(sql.structuredContent).toMatchObject({ rows, row_count: 600 });
});
it('stages a bounded whole set even for a small first page and leaves later pages alone', async () => {
  enabled = true;
  searchOccurrences.mockResolvedValue({ rows: rows.slice(0, 5), meta: { recordsFound: 601 } });
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 5,
  });
  expect(result.structuredContent).toMatchObject({
    spilled: true,
    row_count: 601,
    occurrences: rows.slice(0, 5),
    totalCount: 601,
  });
  expect(searchOccurrenceSet).toHaveBeenCalledOnce();
  searchOccurrenceSet.mockClear();
  acquire.mockClear();
  const later = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 5,
    offset: 5,
    canvas_id: 'abcdefghij',
  });
  expect(later.structuredContent).toMatchObject({ spilled: false, row_count: 5 });
  expect(acquire).not.toHaveBeenCalled();
  expect(searchOccurrenceSet).not.toHaveBeenCalled();
});
it('preserves prior table when restaging fails', async () => {
  enabled = true;
  registerTable.mockRejectedValue(new Error('conversion failure'));
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 600,
    canvas_id: 'abcdefghij',
  });
  expect(result.isError).toBe(true);
  expect(drop).not.toHaveBeenCalled();
});
it('wires normalized country and exact formation into page and set requests', async () => {
  enabled = true;
  const result = await runToolContract(searchOccurrencesTool, {
    country: ' us , ca ',
    formation: 'Hell Creek Formation',
    limit: 600,
  });
  expect(result.isError).toBeFalsy();
  expect(searchOccurrences.mock.calls[0]?.[0]).toMatchObject({
    country: 'US,CA',
    formation: 'Hell Creek Formation',
  });
  expect(searchOccurrenceSet.mock.calls[0]?.[0]).toMatchObject({
    country: 'US,CA',
    formation: 'Hell Creek Formation',
  });
});
it('degrades only a transient extra fetch and cleans up a fresh canvas', async () => {
  enabled = true;
  acquire.mockResolvedValue({ canvasId: 'abcdefghij', isNew: true, registerTable });
  searchOccurrenceSet.mockRejectedValue(
    new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB unavailable'),
  );
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 600,
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    occurrences: rows,
    row_count: 600,
    spilled: false,
    notice: expect.stringContaining('temporarily unavailable'),
  });
  expect(JSON.stringify(result.content)).toContain('temporarily unavailable');
  expect(drop).toHaveBeenCalledOnce();
  expect(registerTable).not.toHaveBeenCalled();
});
it('never degrades caller cancellation or invalid canvas identity', async () => {
  enabled = true;
  const controller = new AbortController();
  searchOccurrenceSet.mockImplementation(() => {
    controller.abort();
    throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB unavailable');
  });
  const cancelled = await runToolContract(
    searchOccurrencesTool,
    { base_name: 'Dinosauria', limit: 600 },
    { context: { signal: controller.signal } },
  );
  expect(cancelled.isError).toBe(true);
  expect(cancelled.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  acquire.mockRejectedValue(
    new McpError(JsonRpcErrorCode.NotFound, 'Canvas not found', { reason: 'canvas_not_found' }),
  );
  const invalid = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 600,
    canvas_id: 'abcdefghij',
  });
  expect(invalid.isError).toBe(true);
  expect(invalid.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'canvas_not_found' } },
  });
});
it('keeps canvas-cap failure typed and does not promise a smaller page avoids staging', async () => {
  enabled = true;
  acquire.mockRejectedValue(
    new McpError(JsonRpcErrorCode.RateLimited, 'capacity', { reason: 'canvas_capacity_exhausted' }),
  );
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 1,
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      data: {
        reason: 'canvas_capacity_exhausted',
        recovery: {
          hint: 'Pass a canvas_id you already hold to replace its occurrence table, or narrow the matching set until it fits in the requested page.',
        },
      },
    },
  });
});
it('shares a bounded deadline between page, extra acquisition, and staging', async () => {
  enabled = true;
  await runToolContract(searchOccurrencesTool, { base_name: 'Dinosauria', limit: 600 });
  const pageSignal = searchOccurrences.mock.calls[0]?.[1].signal;
  expect(pageSignal).toBeInstanceOf(AbortSignal);
  expect(searchOccurrenceSet.mock.calls[0]?.[1].signal).toBe(pageSignal);
  expect(registerTable.mock.calls[0]?.[2].signal).toBe(pageSignal);
});
it('does not infer staging completeness without its own upstream total', async () => {
  enabled = true;
  searchOccurrenceSet.mockResolvedValue({
    rows: rows.slice(0, 5),
    meta: { warnings: ['staging warning'] },
  });
  const result = await runToolContract(searchOccurrencesTool, {
    base_name: 'Dinosauria',
    limit: 600,
  });
  expect(result.structuredContent).toMatchObject({
    row_count: 5,
    totalCount: 700,
    notice: expect.stringContaining('completeness is unknown'),
  });
  expect(JSON.stringify(result.content)).toContain('staging warning');
  expect(JSON.stringify(result)).not.toContain('contains all');
});
it('keeps caller cancellation when cleanup itself fails', async () => {
  enabled = true;
  const controller = new AbortController();
  acquire.mockResolvedValue({ canvasId: 'abcdefghij', isNew: true, registerTable });
  drop.mockRejectedValue(new Error('cleanup failure'));
  searchOccurrenceSet.mockImplementation(() => {
    controller.abort();
    throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB unavailable');
  });
  const result = await runToolContract(
    searchOccurrencesTool,
    { base_name: 'Dinosauria', limit: 600 },
    { context: { signal: controller.signal } },
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
});
it('echoes lone temporal and spatial bounds plus normalized country without inventing a bound', async () => {
  searchOccurrences.mockResolvedValue({ rows: [], meta: { recordsFound: 0 } });
  const result = await runToolContract(searchOccurrencesTool, {
    min_ma: 65,
    latmax: 40,
    country: 'ca',
    formation: 'Hell Creek Formation',
  });
  expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining('min_ma=65') });
  const all = JSON.stringify(result);
  for (const selector of ['latmax=40', 'country=CA', 'formation=Hell Creek Formation'])
    expect(all).toContain(selector);
  expect(all).not.toContain('all time');
  expect(all).not.toContain('65–0');
});
