/**
 * @fileoverview Handler tests for paleobiology_list_intervals and the
 * canvas-disabled failure on paleobiology_dataframe_query.
 *
 * The bundled ICS snapshot answers offline; only a name the snapshot does not
 * carry reaches PBDB. `lookupInterval` is mocked to a spy so both halves of that
 * contract are assertable: every bundled path asserts the spy was NOT called, and
 * the miss paths drive the upstream hit, the upstream miss, and the upstream
 * failure without touching the network.
 * @module tests/tools/list-intervals.tool
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initIntervalIndex } from '@/services/intervals/interval-index.js';
import type { Interval } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';

const lookupInterval = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ lookupInterval }) };
});

const { dataframeQueryTool } = await import(
  '@/mcp-server/tools/definitions/dataframe-query.tool.js'
);
const { listIntervalsTool } = await import('@/mcp-server/tools/definitions/list-intervals.tool.js');

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

/** `Late Maastrichtian` as the service normalizes it — PBDB interval 654, scale 12. */
function lateMaastrichtian(): Interval {
  return {
    interval_no: 654,
    name: 'Late Maastrichtian',
    level: 'subage',
    max_ma: 72.2,
    min_ma: 66,
    scale: 'Mesozoic Subages',
  };
}

beforeAll(() => {
  initIntervalIndex();
});

beforeEach(() => {
  lookupInterval.mockReset();
});

describe('paleobiology_list_intervals', () => {
  it('translates a named interval to its Ma boundaries with NO upstream call', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Maastrichtian' });
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0]).toMatchObject({
      name: 'Maastrichtian',
      level: 'age',
      max_ma: 72.2,
      min_ma: 66,
    });
    expect(result.intervals[0]).not.toHaveProperty('scale');
    expect(result.source).toBe('bundled_ics');
    expect(result.snapshot_version).toMatch(/^ICS /);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
    // The offline guarantee: a name the snapshot knows never reaches the network.
    expect(lookupInterval).not.toHaveBeenCalled();
  });

  it('never reaches upstream for a known name excluded by the level filter', async () => {
    // The snapshot carries "Maastrichtian" but as an age, not a period. An empty
    // result here is a bundled answer — not a reason to go looking upstream.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Maastrichtian', level: 'period' });
    await expect(listIntervalsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'interval_not_found' },
    });
    expect(lookupInterval).not.toHaveBeenCalled();
  });

  it('resolves a sub-stage name upstream when the bundled snapshot misses (#19)', async () => {
    lookupInterval.mockResolvedValue(lateMaastrichtian());
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Late Maastrichtian' });
    const result = await listIntervalsTool.handler(input, ctx);

    expect(lookupInterval).toHaveBeenCalledWith('Late Maastrichtian', ctx);
    expect(result).toEqual(expect.schemaMatching(listIntervalsTool.output));
    expect(result.source).toBe('pbdb_upstream');
    expect(result.intervals).toEqual([
      {
        interval_no: 654,
        name: 'Late Maastrichtian',
        level: 'subage',
        max_ma: 72.2,
        min_ma: 66,
        scale: 'Mesozoic Subages',
      },
    ]);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
    // content[]-only clients see the rank, the boundaries, the scale, and the source.
    const text = renderText(listIntervalsTool.format?.(result));
    expect(text).toContain('source: pbdb_upstream');
    expect(text).toContain('**Late Maastrichtian** (subage) · 72.2–66 Ma · int #654');
    expect(text).toContain('scale Mesozoic Subages');
  });

  it('applies the caller Ma window to the upstream hit', async () => {
    // Lancian spans 72.2–66 Ma; a 200–150 Ma window excludes it, so the answer is
    // "no match" rather than an interval the caller filtered out.
    lookupInterval.mockResolvedValue({
      interval_no: 744,
      name: 'Lancian',
      level: 'age',
      max_ma: 72.2,
      min_ma: 66,
      scale: 'Cretaceous North American Land-Mammal Ages',
    } satisfies Interval);
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Lancian', min_ma: 150, max_ma: 200 });
    await expect(listIntervalsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'interval_not_found' },
    });

    // Same name, a window that does overlap: resolved, and labeled with its scale.
    const ctx2 = createMockContext({ errors: listIntervalsTool.errors });
    const input2 = listIntervalsTool.input.parse({ name: 'Lancian', min_ma: 66, max_ma: 80 });
    const result = await listIntervalsTool.handler(input2, ctx2);
    expect(result.intervals[0]).toMatchObject({
      name: 'Lancian',
      max_ma: 72.2,
      min_ma: 66,
      scale: 'Cretaceous North American Land-Mammal Ages',
    });
    expect(result.source).toBe('pbdb_upstream');
  });

  it('throws interval_not_found when neither the snapshot nor PBDB has the name', async () => {
    lookupInterval.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Notaperiodxyz' });
    const err = await expectMcpError(() => listIntervalsTool.handler(input, ctx));
    expect(lookupInterval).toHaveBeenCalledWith('Notaperiodxyz', ctx);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('interval_not_found');
    expect(err.data).toMatchObject({
      recovery: { hint: expect.stringMatching(/browse the international scale/) },
    });
  });

  it('declares interval_not_found below error severity, the unreachable-PBDB reason at the default', () => {
    // A name miss is an ordinary lookup answer; an unreachable PBDB is a real
    // upstream fault and must stay in the error stream operators alert on.
    const entries: readonly { reason: string; severity?: string }[] =
      listIntervalsTool.errors ?? [];
    expect(entries.find((e) => e.reason === 'interval_not_found')?.severity).toBe('info');
    expect(
      entries.find((e) => e.reason === 'interval_lookup_unavailable')?.severity,
    ).toBeUndefined();
  });

  it('reports an unreachable PBDB as unavailable, never as a missing interval', async () => {
    // Conflating the two would tell the agent a real interval does not exist.
    lookupInterval.mockRejectedValue(
      serviceUnavailable('PBDB is unavailable during lookupInterval.'),
    );
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Late Maastrichtian' });
    const err = await expectMcpError(() => listIntervalsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('interval_lookup_unavailable');
    expect(err.message).toContain('Late Maastrichtian');
    expect(err.data).toMatchObject({
      recovery: { hint: expect.stringMatching(/Retry in a moment/) },
    });
    // The internal operation name must not ride out on the agent-facing error.
    expect(err.message).not.toContain('lookupInterval');
  });

  it('returns the full scale when called with no filters', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({});
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals.length).toBeGreaterThan(150);
    expect(result.source).toBe('bundled_ics');
    expect(lookupInterval).not.toHaveBeenCalled();
  });

  it('resolves a named interval to Ma and back via a Ma-overlap filter', async () => {
    // Ma→names: 70 Ma overlaps the Maastrichtian (66–72.2). This is the inverse
    // of the name→Ma lookup and must NOT raise interval_not_found.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ min_ma: 70, max_ma: 70, level: 'age' });
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals.map((iv) => iv.name)).toContain('Maastrichtian');
  });

  it('returns an EMPTY list with a notice (not an error) for a Ma/level filter that matches nothing', async () => {
    // A name filter that matches nothing is interval_not_found; an empty Ma/level
    // filter is a valid empty list — and no name means nothing to look up upstream.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ min_ma: 9000, max_ma: 9999 });
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals).toEqual([]);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 0 });
    expect(String(getEnrichment(ctx).notice)).toMatch(/No interval matched the Ma\/level filters/);
    expect(lookupInterval).not.toHaveBeenCalled();
  });

  it('restricts results to a single level when level is given', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ level: 'period' });
    const result = await listIntervalsTool.handler(input, ctx);
    expect(result.intervals.length).toBeGreaterThan(10);
    expect(result.intervals.every((iv) => iv.level === 'period')).toBe(true);
    expect(result.intervals.map((iv) => iv.name)).toContain('Cretaceous');
    expect(result.intervals.map((iv) => iv.name)).not.toContain('Maastrichtian');
  });

  it('returns filtered results oldest-first, matching the schema and format()', async () => {
    // Every filtered path used to return raw snapshot order (~youngest-first)
    // while only the unfiltered path sorted — the schema promises oldest-first.
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const periods = await listIntervalsTool.handler(
      listIntervalsTool.input.parse({ level: 'period' }),
      ctx,
    );
    expect(periods.intervals[0]?.name).toBe('Siderian');
    expect(periods.intervals.at(-1)?.name).toBe('Quaternary');
    for (let i = 1; i < periods.intervals.length; i++) {
      expect(periods.intervals[i - 1]!.max_ma).toBeGreaterThanOrEqual(periods.intervals[i]!.max_ma);
    }
    // format() renders the same order for content[]-only clients.
    const text = renderText(listIntervalsTool.format?.(periods));
    expect(text.indexOf('Siderian')).toBeLessThan(text.indexOf('Quaternary'));

    const cretaceous = await listIntervalsTool.handler(
      listIntervalsTool.input.parse({ name: 'cretaceous' }),
      createMockContext({ errors: listIntervalsTool.errors }),
    );
    expect(cretaceous.intervals.map((iv) => iv.name)).toEqual([
      'Cretaceous',
      'Early Cretaceous',
      'Late Cretaceous',
    ]);
  });

  it('format() renders the snapshot version and source header for citation', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Jurassic' });
    const result = await listIntervalsTool.handler(input, ctx);
    const text = renderText(listIntervalsTool.format?.(result));
    expect(text).toMatch(/Geologic intervals.*ICS.*source: bundled_ics/s);
  });

  it('renders every output field in format() (parity smoke-check)', async () => {
    const ctx = createMockContext({ errors: listIntervalsTool.errors });
    const input = listIntervalsTool.input.parse({ name: 'Cretaceous', level: 'period' });
    const result = await listIntervalsTool.handler(input, ctx);
    const text = renderText(listIntervalsTool.format?.(result));
    expect(text).toContain('Cretaceous');
    expect(text).toContain('Ma');
    expect(text).toContain('bundled_ics');
  });
});

describe('paleobiology_dataframe_query (canvas disabled)', () => {
  it('throws canvas_disabled when DataCanvas is not enabled', async () => {
    // No setCanvas() called → getCanvas() is undefined in this test process.
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ canvas_id: 'abc1234567', sql: 'SELECT 1' });
    const err = await expectMcpError(() => dataframeQueryTool.handler(input, ctx));
    expect(err.data?.reason).toBe('canvas_disabled');
  });
});
