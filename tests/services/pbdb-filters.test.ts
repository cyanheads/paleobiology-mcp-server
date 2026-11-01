/**
 * @fileoverview PBDB filter and bounded occurrence-set requests through the real service.
 * @module tests/services/pbdb-filters
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();
vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout,
}));
const { PbdbService } = await import('@/services/pbdb/pbdb-service.js');
const service = new PbdbService({} as never);

describe('PBDB request filters', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockImplementation(
      async () => new Response(JSON.stringify({ records: [], records_found: 0 })),
    );
  });

  it('characterizes existing formation strings and occurrence page coordinates', async () => {
    await service.searchCollections(
      { formation: 'Hell Creek,Morrison%', offset: 2, limit: 3 },
      createMockContext(),
    );
    const url = new URL(fetchWithTimeout.mock.calls[0]![0]);
    expect(url.searchParams.get('formation')).toBe('Hell Creek,Morrison%');
    expect(url.searchParams.has('strat')).toBe(false);
    expect(url.searchParams.get('offset')).toBe('2');
  });

  it('maps occurrence and collection country without changing formation strings', async () => {
    await service.searchOccurrences(
      { country: 'NOA,^US', formation: 'Hell Creek Formation', offset: 3, limit: 2 },
      createMockContext(),
    );
    let url = new URL(fetchWithTimeout.mock.calls[0]![0]);
    expect(url.searchParams.get('cc')).toBe('NOA,^US');
    expect(url.searchParams.get('formation')).toBe('Hell Creek Formation');
    await service.searchCollections(
      { country: '!EUR,^IS', limit: 1, offset: 0 },
      createMockContext(),
    );
    url = new URL(fetchWithTimeout.mock.calls[1]![0]);
    expect(url.searchParams.get('cc')).toBe('!EUR,^IS');
  });

  it.each([false, true])(
    'maps diversity filters with recent=%s presence semantics',
    async (recent) => {
      await service.getDiversity(
        {
          baseId: 36616,
          count: 'genera',
          resolution: 'age',
          recent,
          country: 'US',
          formation: 'Hell Creek',
          environment: 'freshwater',
          lngmin: 170,
          lngmax: -170,
          latmin: 60,
        },
        createMockContext(),
      );
      const params = new URL(fetchWithTimeout.mock.calls[0]![0]).searchParams;
      expect(params.get('base_id')).toBe('txn:36616');
      expect(params.get('formation')).toBe('Hell Creek');
      expect(params.get('cc')).toBe('US');
      expect(params.get('envtype')).toBe('lacustrine,fluvial');
      expect(params.get('lngmin')).toBe('170');
      expect(params.get('lngmax')).toBe('-170');
      expect(params.get('latmin')).toBe('60');
      expect(params.has('recent')).toBe(recent);
      if (recent) expect(params.get('recent')).toBe('yes');
    },
  );

  it('pulls a bounded occurrence set from offset zero with the same selectors', async () => {
    fetchWithTimeout.mockResolvedValue(
      new Response(
        JSON.stringify({
          records: [{ occurrence_no: '139340', formation: 'Hell Creek', cc: 'US' }],
          records_found: 50001,
          warnings: ['test warning'],
        }),
      ),
    );
    const result = await service.searchOccurrenceSet(
      {
        baseId: 52775,
        country: 'US',
        formation: 'Hell Creek',
        environment: 'freshwater',
        interval: 'Cretaceous',
        latmax: -60,
        offset: 99,
        limit: 2,
      },
      createMockContext(),
    );
    const params = new URL(fetchWithTimeout.mock.calls[0]![0]).searchParams;
    expect(params.get('limit')).toBe('50000');
    expect(params.get('offset')).toBe('0');
    expect(params.get('cc')).toBe('US');
    expect(params.get('formation')).toBe('Hell Creek');
    expect(params.get('envtype')).toBe('lacustrine,fluvial');
    expect(params.get('base_id')).toBe('txn:52775');
    expect(params.get('latmax')).toBe('-60');
    expect(result).toMatchObject({
      rows: [{ occurrence_no: 139340, formation: 'Hell Creek', cc: 'US' }],
      meta: { recordsFound: 50001, warnings: ['test warning'] },
    });
  });

  it('preserves the captured Mammalia first/last-appearance arithmetic with recent ranges', async () => {
    for (const [recent, youngest, oldest] of [
      [
        false,
        { X_Ft: 0, X_bL: 460, X_FL: 150, X_bt: 0 },
        { X_Ft: 246, X_bL: 0, X_FL: 38, X_bt: 0 },
      ],
      [
        true,
        { X_Ft: 105, X_bL: 110, X_FL: 45, X_bt: 453 },
        { X_Ft: 252, X_bL: 0, X_FL: 32, X_bt: 0 },
      ],
    ] as const) {
      fetchWithTimeout.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [
              {
                interval_name: 'Late Pleistocene',
                max_ma: 0.129,
                min_ma: 0.0117,
                sampled_in_bin: 610,
                ...youngest,
              },
              {
                interval_name: 'Gelasian',
                max_ma: 2.58,
                min_ma: 1.8,
                sampled_in_bin: 284,
                ...oldest,
              },
            ],
          }),
        ),
      );
      const result = await service.getDiversity(
        {
          baseName: 'Mammalia',
          interval: 'Pleistocene',
          count: 'genera',
          resolution: 'age',
          recent,
        },
        createMockContext(),
      );
      expect(result.bins[0]).toMatchObject({
        sampled_in_bin: 610,
        extinctions: recent ? 155 : 610,
      });
      expect(result.bins[1]).toMatchObject({ originations: 284 });
    }
  });

  it('passes the caller signal into the bounded set request and returns empty metadata', async () => {
    const controller = new AbortController();
    const result = await service.searchOccurrenceSet(
      { limit: 1, offset: 100 },
      createMockContext({ signal: controller.signal }),
    );
    expect(fetchWithTimeout.mock.calls[0]![3]).toMatchObject({ signal: controller.signal });
    expect(result).toEqual({ rows: [], meta: { recordsFound: 0 } });
  });
});
