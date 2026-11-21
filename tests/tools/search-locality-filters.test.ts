/**
 * @fileoverview Locality selectors through the tool contract and real PBDB service.
 * @module tests/tools/search-locality-filters
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();
vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout,
}));

const { searchCollectionsTool } = await import(
  '@/mcp-server/tools/definitions/search-collections.tool.js'
);
const { searchOccurrencesTool } = await import(
  '@/mcp-server/tools/definitions/search-occurrences.tool.js'
);
const { initPbdbService } = await import('@/services/pbdb/pbdb-service.js');
const { setCanvas } = await import('@/services/canvas-accessor.js');

const localities = [
  {
    collection_no: '11931',
    lat: 47.6377,
    lng: -106.569901,
    paleolat: '58.34',
    paleolng: -64.7,
    paleomodel: 'gplates',
  },
  { collection_no: '12977', paleolng: 0 },
];

function reply(records: unknown[], total = records.length, warnings?: string[]): Response {
  return Response.json({ records, records_found: total, warnings });
}

function params(call: number): URLSearchParams {
  return new URL(fetchWithTimeout.mock.calls[call]![0]).searchParams;
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation(() => Promise.resolve(reply([])));
  initPbdbService({} as never);
});

describe('collection drilldown', () => {
  it('round-trips the ID list, sparse paleocoordinates and every served locality', async () => {
    fetchWithTimeout.mockResolvedValueOnce(reply(localities));
    const result = await runToolContract(searchCollectionsTool, { collection_no: [11931, 12977] });
    expect(result.isError).toBeFalsy();
    expect(params(0).get('coll_id')).toBe('11931,12977');
    expect(params(0).get('show')).toBe('loc,strat,lith,env,time,paleoloc');
    expect(result.structuredContent).toMatchObject({
      collections: [
        {
          collection_no: 11931,
          lat: 47.6377,
          lng: -106.569901,
          paleolat: 58.34,
          paleolng: -64.7,
          paleomodel: 'gplates',
        },
        { collection_no: 12977, paleolng: 0 },
      ],
      totalCount: 2,
    });
    expect(result.structuredContent).toHaveProperty('collections.1', {
      collection_no: 12977,
      paleolng: 0,
    });
    expect(JSON.stringify(result.content)).toContain('**modern coords:** 47.6377, -106.569901');
    expect(JSON.stringify(result.content)).toContain('**paleo coords:** 58.34, -64.7 [gplates]');
    expect(JSON.stringify(result.content)).toContain('**paleolng:** 0');
  });

  it('pages selected localities, including an offset past the end', async () => {
    const args = { collection_no: [11931, 12977], formation: 'Hell Creek', limit: 1 };
    fetchWithTimeout
      .mockResolvedValueOnce(reply(localities.slice(0, 1), 2))
      .mockResolvedValueOnce(reply(localities.slice(1), 2))
      .mockResolvedValueOnce(reply([], 2));
    const first = await runToolContract(searchCollectionsTool, args);
    const second = await runToolContract(searchCollectionsTool, { ...args, offset: 1 });
    const after = await runToolContract(searchCollectionsTool, { ...args, offset: 2 });
    expect(first.structuredContent).toMatchObject({
      collections: [{ collection_no: 11931 }],
      totalCount: 2,
      shown: 1,
      cap: 1,
      truncated: true,
      notice: expect.stringContaining('Advance offset to 1'),
    });
    expect(JSON.stringify(first.content)).toContain('Advance offset to 1');
    expect(second.structuredContent).toMatchObject({
      collections: [{ collection_no: 12977 }],
      totalCount: 2,
    });
    expect(second.structuredContent).not.toHaveProperty('truncated');
    expect(after.structuredContent).toMatchObject({
      collections: [],
      totalCount: 2,
      notice: expect.stringContaining('Offset 2 is past the end'),
    });
    expect(JSON.stringify(after.content)).toContain('Offset 2 is past the end');
    expect(
      [0, 1, 2].map((i) => [
        params(i).get('coll_id'),
        params(i).get('formation'),
        params(i).get('offset'),
      ]),
    ).toEqual([
      ['11931,12977', 'Hell Creek', '0'],
      ['11931,12977', 'Hell Creek', '1'],
      ['11931,12977', 'Hell Creek', '2'],
    ]);
  });

  it.each([[], [0], [1.5], Array.from({ length: 1_001 }, (_, i) => i + 1)].map((ids) => ({ ids })))(
    'rejects invalid collection identifiers before calling PBDB %#',
    async ({ ids }) => {
      const result = await runToolContract(searchCollectionsTool, { collection_no: ids });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    },
  );

  it('accepts 1,000 IDs and echoes an unknown selector with its upstream warning', async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => i + 1);
    const max = await runToolContract(searchCollectionsTool, { collection_no: ids });
    expect(max.isError).toBeFalsy();
    expect(params(0).get('coll_id')).toBe(ids.join(','));

    fetchWithTimeout.mockResolvedValueOnce(reply([], 0, ["Unknown collection '999999999'"]));
    const miss = await runToolContract(searchCollectionsTool, { collection_no: [999999999] });
    expect(miss.structuredContent).toMatchObject({ collections: [], totalCount: 0 });
    for (const expected of ['Unknown collection', 'collection_no=999999999']) {
      expect(miss.structuredContent).toMatchObject({ notice: expect.stringContaining(expected) });
      expect(JSON.stringify(miss.content)).toContain(expected);
    }
    expect(JSON.stringify(miss.structuredContent)).not.toContain('did not constrain');
    expect(JSON.stringify(miss.content)).not.toContain('did not constrain');
  });
});

describe('administrative locality selectors', () => {
  it('names the upstream accepted taxon identifier consistently on both response surfaces', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      reply([{ occurrence_no: '139340', collection_no: '11931', accepted_no: '54833' }]),
    );
    const result = await runToolContract(searchOccurrencesTool, { collection_no: 11931 });
    expect(result.structuredContent).toMatchObject({
      occurrences: [{ occurrence_no: 139340, collection_no: 11931, accepted_no: 54833 }],
    });
    expect(JSON.stringify(result.content)).toContain('**accepted_no:** 54833');
    expect(JSON.stringify(result.content)).not.toContain('**taxon_no:** 54833');
  });

  for (const search of [searchCollectionsTool, searchOccurrencesTool]) {
    it.each([{ state: 'Texas' }, { county: 'Brewster' }])(
      `${search.name} accepts %o as its only selector`,
      async (filter) => {
        const result = await runToolContract(search, filter);
        expect(result.isError).toBeFalsy();
        for (const [key, value] of Object.entries(filter)) {
          expect(params(0).get(key)).toBe(value);
          expect(result.structuredContent).toMatchObject({
            notice: expect.stringContaining(`${key}=${value}`),
          });
          expect(JSON.stringify(result.content)).toContain(`${key}=${value}`);
        }
      },
    );

    it(`${search.name} treats blank places as unset and retains the typed missing-selector recovery`, async () => {
      const result = await runToolContract(search, { state: '', county: '   ' });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: { reason: 'missing_filter', recovery: { hint: expect.stringContaining('state') } },
        },
      });
      expect(JSON.stringify(result.content)).toContain('missing_filter');
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it(`${search.name} combines place filters and discloses a PBDB warning on both surfaces`, async () => {
      fetchWithTimeout.mockResolvedValueOnce(
        reply([], 0, ["Field 'county': the value 'NotAPlace' was not found in the database"]),
      );
      const result = await runToolContract(search, {
        country: 'US',
        state: 'Texas',
        county: 'NotAPlace',
      });
      expect(result.isError).toBeFalsy();
      expect(params(0).get('cc')).toBe('US');
      expect(params(0).get('state')).toBe('Texas');
      expect(params(0).get('county')).toBe('NotAPlace');
      for (const expected of ['state=Texas', 'county=NotAPlace', 'was not found in the database']) {
        expect(result.structuredContent).toMatchObject({
          notice: expect.stringContaining(expected),
        });
        expect(JSON.stringify(result.content)).toContain(expected);
      }
    });
  }

  it('forwards identical list filter values to the occurrence page and whole-set requests', async () => {
    const registerTable = vi.fn().mockResolvedValue({ rowCount: 2 });
    setCanvas({ acquire: async () => ({ canvasId: 'locality01', registerTable }) } as never);
    fetchWithTimeout
      .mockResolvedValueOnce(
        reply([{ occurrence_no: '139340', state: 'Montana', county: 'Garfield' }], 2),
      )
      .mockResolvedValueOnce(reply([{ occurrence_no: '139340' }, { occurrence_no: '139341' }], 2));
    try {
      const result = await runToolContract(searchOccurrencesTool, {
        country: 'US',
        state: 'Montana,Texas',
        county: 'Garfield,Brewster',
        limit: 1,
      });
      expect(result.structuredContent).toMatchObject({
        spilled: true,
        row_count: 2,
        totalCount: 2,
      });
      expect(JSON.stringify(result.content)).toContain('Garfield, Montana');
      expect(
        [0, 1].map((i) => [
          params(i).get('cc'),
          params(i).get('state'),
          params(i).get('county'),
          params(i).get('limit'),
        ]),
      ).toEqual([
        ['US', 'Montana,Texas', 'Garfield,Brewster', '1'],
        ['US', 'Montana,Texas', 'Garfield,Brewster', '50000'],
      ]);
      expect(registerTable).toHaveBeenCalledOnce();
    } finally {
      setCanvas(undefined);
    }
  });
});
