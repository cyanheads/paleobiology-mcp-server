/**
 * @fileoverview Handler tests for paleobiology_list_intervals (in-memory, no
 * network) and the canvas-disabled failure on paleobiology_dataframe_query.
 * @module tests/tools/list-intervals.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { listIntervalsTool } from '@/mcp-server/tools/definitions/list-intervals.tool.js';
import { initIntervalIndex } from '@/services/intervals/interval-index.js';

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

beforeAll(() => {
  initIntervalIndex();
});

describe('paleobiology_list_intervals', () => {
  it('translates a named interval to its Ma boundaries', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Maastrichtian' });
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0]).toMatchObject({ name: 'Maastrichtian', max_ma: 72.2, min_ma: 66 });
    expect(result.snapshot_version).toMatch(/^ICS /);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
  });

  it('throws interval_not_found for an unknown named interval', () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Notaperiodxyz' });
    // The handler is synchronous, so it throws synchronously — catch directly.
    let reason: string | undefined;
    try {
      listIntervalsTool.handler(input, ctx);
    } catch (e) {
      reason = (e as { data?: { reason?: string } }).data?.reason;
    }
    expect(reason).toBe('interval_not_found');
  });

  it('returns the full scale when called with no filters', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({});
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals.length).toBeGreaterThan(150);
  });

  it('resolves a named interval to Ma and back via a Ma-overlap filter', () => {
    // Ma→names: 70 Ma overlaps the Maastrichtian (66–72.2). This is the inverse
    // of the name→Ma lookup and must NOT raise interval_not_found.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ min_ma: 70, max_ma: 70, level: 'age' });
    const result = listIntervalsTool.handler(input, ctx) as {
      intervals: { name: string }[];
    };
    expect(result.intervals.map((iv) => iv.name)).toContain('Maastrichtian');
  });

  it('returns an EMPTY list with a notice (not an error) for a Ma/level filter that matches nothing', () => {
    // A name filter that matches nothing is interval_not_found; an empty Ma/level
    // filter is a valid empty list. This distinction is the contract — keep it.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ min_ma: 9000, max_ma: 9999 });
    const result = listIntervalsTool.handler(input, ctx) as { intervals: unknown[] };
    expect(result.intervals).toEqual([]);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 0 });
    expect(String(getEnrichment(ctx).notice)).toMatch(/No interval matched the Ma\/level filters/);
  });

  it('restricts results to a single level when level is given', () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ level: 'period' });
    const result = listIntervalsTool.handler(input, ctx) as {
      intervals: { name: string; level: string }[];
    };
    expect(result.intervals.length).toBeGreaterThan(10);
    expect(result.intervals.every((iv) => iv.level === 'period')).toBe(true);
    expect(result.intervals.map((iv) => iv.name)).toContain('Cretaceous');
    expect(result.intervals.map((iv) => iv.name)).not.toContain('Maastrichtian');
  });

  it('returns filtered results oldest-first, matching the schema and format()', () => {
    // Every filtered path used to return raw snapshot order (~youngest-first)
    // while only the unfiltered path sorted — the schema promises oldest-first.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const periods = listIntervalsTool.handler(
      listIntervalsTool.input.parse({ level: 'period' }),
      ctx,
    ) as { intervals: { name: string; max_ma: number }[] };
    expect(periods.intervals[0]?.name).toBe('Siderian');
    expect(periods.intervals.at(-1)?.name).toBe('Quaternary');
    for (let i = 1; i < periods.intervals.length; i++) {
      expect(periods.intervals[i - 1]!.max_ma).toBeGreaterThanOrEqual(periods.intervals[i]!.max_ma);
    }
    // format() renders the same order for content[]-only clients.
    const text = renderText(listIntervalsTool.format?.(periods as never));
    expect(text.indexOf('Siderian')).toBeLessThan(text.indexOf('Quaternary'));

    const cretaceous = listIntervalsTool.handler(
      listIntervalsTool.input.parse({ name: 'cretaceous' }),
      createMockContext({ errors: listIntervalsTool.errors }),
    ) as { intervals: { name: string }[] };
    expect(cretaceous.intervals.map((iv) => iv.name)).toEqual([
      'Cretaceous',
      'Early Cretaceous',
      'Late Cretaceous',
    ]);
  });

  it('format() renders the snapshot version header for citation', () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Jurassic' });
    const result = listIntervalsTool.handler(input, ctx) as never;
    const text = renderText(listIntervalsTool.format?.(result));
    expect(text).toMatch(/Geologic intervals.*ICS/s);
  });

  it('renders every output field in format() (parity smoke-check)', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Cretaceous', level: 'period' });
    const result = await listIntervalsTool.handler(input, ctx);
    const text = (listIntervalsTool.format?.(result) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toContain('Cretaceous');
    expect(text).toContain('Ma');
  });
});

describe('paleobiology_dataframe_query (canvas disabled)', () => {
  it('throws canvas_disabled when DataCanvas is not enabled', async () => {
    // No setCanvas() called → getCanvas() is undefined in this test process.
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ canvas_id: 'abc1234567', sql: 'SELECT 1' });
    const err = await dataframeQueryTool.handler(input, ctx).then(
      () => undefined,
      (e) => e as { data?: { reason?: string } },
    );
    expect(err?.data?.reason).toBe('canvas_disabled');
  });
});
