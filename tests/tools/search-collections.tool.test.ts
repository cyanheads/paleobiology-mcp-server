/**
 * @fileoverview Handler tests for paleobiology_search_collections. Covers the
 * happy path, the empty-result path (required-field-on-empty: { collections: []
 * } still validates, with a notice), pagination against PBDB's true match count
 * (the page numbered from offset, and no remainder claimed on a final page that
 * exactly fills the limit), the ignored-filter warning disclosure on a full
 * unfiltered result, the filter → service mapping, format() parity, and a sparse
 * locality.
 *
 * The PBDB layer is never hit: getPbdbService().searchCollections is a per-test
 * fake returning the CollectionResult the service would.
 * @module tests/tools/search-collections.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, CollectionFilter, CollectionResult } from '@/services/pbdb/types.js';

const searchCollections = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ searchCollections }) };
});

const { searchCollectionsTool } = await import(
  '@/mcp-server/tools/definitions/search-collections.tool.js'
);

const hellCreek: Collection = {
  collection_no: 11917,
  collection_name: "Knudsen's Coulee",
  lng: -113.0289,
  lat: 51.9064,
  early_interval: 'Late Maastrichtian',
  max_ma: 72.2,
  min_ma: 66,
  formation: 'Scollard',
  lithology: 'sandstone',
  lithology_description: 'concretionary zone in the basal part of a channel sandstone',
  environment: 'channel',
  cc: 'CA',
  n_occs: 12,
  reference_no: 4218,
};

/**
 * Build the CollectionResult the service returns for a given page of rows.
 * `total` is PBDB's true match count; `truncated` is the service's own verdict
 * (`offset + shown < total`), passed through so the handler's notice copy can be
 * asserted independently of how the service computed it.
 */
function result(rows: Collection[], overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    collections: rows,
    shown: rows.length,
    offset: 0,
    truncated: false,
    cap: 100,
    total: rows.length,
    ...overrides,
  };
}

describe('paleobiology_search_collections', () => {
  beforeEach(() => {
    searchCollections.mockReset();
  });

  it('returns localities and conforms to the output schema', async () => {
    searchCollections.mockResolvedValue(result([hellCreek]));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ formation: 'Hell Creek' });
    const out = await searchCollectionsTool.handler(input, ctx);

    expect(out).toEqual(expect.schemaMatching(searchCollectionsTool.output));
    expect(out.collections).toHaveLength(1);
    expect(out.collections[0]).toMatchObject({ collection_no: 11917, lithology: 'sandstone' });
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
  });

  it('returns { collections: [] } (still valid) with a notice on an empty result', async () => {
    searchCollections.mockResolvedValue(result([]));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ formation: 'Nonexistent Fm' });
    const out = await searchCollectionsTool.handler(input, ctx);

    expect(out).toEqual(expect.schemaMatching(searchCollectionsTool.output));
    expect(out.collections).toEqual([]);
    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(0);
    expect(String(enr.notice)).toMatch(/No localities matched/);
    // #3: attribution rides enrichment alongside notice — both reach content[] via the trailer.
    expect(String(enr.attribution)).toMatch(/Paleobiology Database/);
  });

  it('rejects an unfiltered call before hitting PBDB (missing_filter)', async () => {
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    for (const raw of [{}, { limit: 3, offset: 0 }]) {
      const input = searchCollectionsTool.input.parse(raw);
      await expect(searchCollectionsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'missing_filter' },
      });
    }
    // PBDB must never be called when no selector was supplied.
    expect(searchCollections).not.toHaveBeenCalled();
  });

  it('accepts base_id as a sole filter and maps it to the service (#20)', async () => {
    let captured: CollectionFilter | undefined;
    searchCollections.mockImplementation(async (filter: CollectionFilter) => {
      captured = filter;
      return result([hellCreek], { total: 84 });
    });
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ base_id: 38613 });
    const out = await searchCollectionsTool.handler(input, ctx);

    expect(captured).toMatchObject({ baseId: 38613, limit: 100, offset: 0 });
    expect(captured).not.toHaveProperty('baseName');
    expect(out.collections).toHaveLength(1);
    expect(getEnrichment(ctx).totalCount).toBe(84);
  });

  it('rejects base_name + base_id together at the boundary (#20)', async () => {
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Tyrannosaurus',
      base_id: 38613,
    });
    const err = (await searchCollectionsTool.handler(input, ctx).catch((e) => e)) as {
      code: number;
      message: string;
      data?: Record<string, unknown>;
    };
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data?.reason).toBe('conflicting_taxon_filter');
    expect(err.message).toBe(
      'Got base_name "Tyrannosaurus" and base_id 38613 — PBDB accepts only one clade selector.',
    );
    expect(JSON.stringify(err.data)).toMatch(/Send base_id alone/);
    expect(searchCollections).not.toHaveBeenCalled();
  });

  it('rejects a half-specified longitude box before hitting PBDB (incomplete_bbox)', async () => {
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    for (const raw of [
      { base_name: 'Dinosauria', lngmin: -130 },
      { base_name: 'Dinosauria', lngmax: -60 },
    ]) {
      const input = searchCollectionsTool.input.parse(raw);
      const err = (await searchCollectionsTool.handler(input, ctx).catch((e) => e)) as {
        code: number;
        data?: Record<string, unknown>;
      };
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data?.reason).toBe('incomplete_bbox');
      expect(JSON.stringify(err.data)).toMatch(/lngmin AND lngmax/);
    }
    expect(searchCollections).not.toHaveBeenCalled();
  });

  it('rejects an inverted or empty Ma window before hitting PBDB (inverted_ma_range)', async () => {
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    for (const raw of [
      { base_name: 'Dinosauria', max_ma: 66, min_ma: 100 },
      { base_name: 'Dinosauria', max_ma: 66, min_ma: 66 },
    ]) {
      const input = searchCollectionsTool.input.parse(raw);
      const err = (await searchCollectionsTool.handler(input, ctx).catch((e) => e)) as {
        code: number;
        data?: Record<string, unknown>;
      };
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data?.reason).toBe('inverted_ma_range');
      expect(JSON.stringify(err.data)).toMatch(/strictly less than max_ma/);
    }
    expect(searchCollections).not.toHaveBeenCalled();
  });

  it('accepts a lone latitude edge and a well-ordered Ma window', async () => {
    searchCollections.mockResolvedValue(result([hellCreek]));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    for (const raw of [
      { base_name: 'Dinosauria', latmin: 40 },
      { base_name: 'Dinosauria', max_ma: 100, min_ma: 66 },
    ]) {
      const input = searchCollectionsTool.input.parse(raw);
      await expect(searchCollectionsTool.handler(input, ctx)).resolves.toMatchObject({
        collections: [expect.objectContaining({ collection_no: 11917 })],
      });
    }
  });

  it('discloses the page against the true total when localities remain (#13)', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...hellCreek, collection_no: i + 1 }));
    searchCollections.mockResolvedValue(result(rows, { cap: 2, truncated: true, total: 653 }));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ base_name: 'Dinosauria', limit: 2 });
    await searchCollectionsTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    // enrich.truncated sets truncated/shown/cap and routes guidance through notice;
    // totalCount now carries the upstream match count, not the page size.
    expect(enr).toMatchObject({ truncated: true, shown: 2, cap: 2, totalCount: 653 });
    expect(String(enr.notice ?? '')).toContain('Showing localities 1–2 of 653');
    expect(String(enr.notice ?? '')).toContain('Advance offset to 2');
  });

  it('numbers the page from the requested offset', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ ...hellCreek, collection_no: i + 1 }));
    searchCollections.mockResolvedValue(
      result(rows, { cap: 100, offset: 80, truncated: true, total: 200 }),
    );
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 100,
      offset: 80,
    });
    await searchCollectionsTool.handler(input, ctx);

    expect(String(getEnrichment(ctx).notice ?? '')).toContain('Showing localities 81–84 of 200');
    expect(String(getEnrichment(ctx).notice ?? '')).toContain('Advance offset to 84');
  });

  it('blames the offset, not the filters, on an empty page past the end (#13)', async () => {
    // The filters matched 84 localities; only the offset was wrong. Sending the
    // agent to "widen the interval or bounding box" would have it fix something
    // that was never broken.
    searchCollections.mockResolvedValue(result([], { cap: 2, offset: 200, total: 84 }));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 2,
      offset: 200,
    });
    await searchCollectionsTool.handler(input, ctx);

    const notice = String(getEnrichment(ctx).notice ?? '');
    expect(notice).toContain('Offset 200 is past the end of the 84 matching localities');
    expect(notice).toContain('Lower offset to below 84');
    expect(notice).not.toContain('Widen the interval');
  });

  it('still blames the filters when nothing matched at all (#13)', async () => {
    // total 0 — the offset is irrelevant, the filters really are too narrow.
    searchCollections.mockResolvedValue(result([], { cap: 2, offset: 0, total: 0 }));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ base_name: 'Tyrannosaurus', limit: 2 });
    await searchCollectionsTool.handler(input, ctx);

    const notice = String(getEnrichment(ctx).notice ?? '');
    expect(notice).toContain('No localities matched the filters');
    expect(notice).not.toContain('past the end');
  });

  it('claims no remainder on a final page that exactly fills the limit (#13)', async () => {
    // The false positive `collections.length >= cap` produced: 84 rows at limit 84
    // with 84 total upstream is the complete set, not a truncated page.
    const rows = Array.from({ length: 84 }, (_, i) => ({ ...hellCreek, collection_no: i + 1 }));
    searchCollections.mockResolvedValue(result(rows, { cap: 84, truncated: false, total: 84 }));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ base_name: 'Tyrannosaurus', limit: 84 });
    await searchCollectionsTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(84);
    expect(enr.truncated).toBeUndefined();
    expect(enr.notice).toBeUndefined();
  });

  it('discloses an ignored lithology filter on a FULL unfiltered result (#12)', async () => {
    // PBDB drops an unrecognized lithology and answers with every locality that
    // matched the rest of the query — indistinguishable from a real match without
    // the warning, and the shown > 0 path never reached the empty-result notice.
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...hellCreek, collection_no: i + 1 }));
    searchCollections.mockResolvedValue(
      result(rows, {
        cap: 3,
        truncated: true,
        total: 1950,
        warnings: [
          "there are no records with lithology or lithology type 'garbagexyz' in the database",
        ],
      }),
    );
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Dinosauria',
      interval: 'Maastrichtian',
      lithology: 'GARBAGEXYZ',
      limit: 3,
    });
    const out = await searchCollectionsTool.handler(input, ctx);

    expect(out.collections).toHaveLength(3);
    const notice = String(getEnrichment(ctx).notice ?? '');
    expect(notice).toContain('PBDB could not use part of this query');
    expect(notice).toContain("lithology or lithology type 'garbagexyz'");
    expect(notice).toContain('That filter did not constrain the result');
    // The truncation guidance still rides the same notice.
    expect(notice).toContain('Showing localities 1–3 of 1950');
    expect(getEnrichment(ctx).totalCount).toBe(1950);
  });

  it('adds no warning notice when every filter was applied (#12)', async () => {
    // A recognized lithology: PBDB filters on it and warns about nothing. The
    // notice carries paging guidance only — no "could not use" disclosure.
    searchCollections.mockResolvedValue(
      result([hellCreek], { cap: 1, truncated: true, total: 653 }),
    );
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Dinosauria',
      lithology: 'sandstone',
      limit: 1,
    });
    await searchCollectionsTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(653);
    const notice = String(enr.notice ?? '');
    expect(notice).not.toContain('could not use');
    expect(notice).toContain('Showing localities 1–1 of 653');
  });

  it('forwards limit/offset and the bbox + filters to the service', async () => {
    let captured: CollectionFilter | undefined;
    searchCollections.mockImplementation(async (filter: CollectionFilter) => {
      captured = filter;
      return result([]);
    });
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({
      base_name: 'Dinosauria',
      interval: 'Maastrichtian',
      lngmin: -120,
      lngmax: -100,
      latmin: 40,
      latmax: 60,
      lithology: 'sandstone',
      environment: 'terrestrial',
      limit: 50,
      offset: 100,
    });
    await searchCollectionsTool.handler(input, ctx);
    expect(captured).toMatchObject({
      baseName: 'Dinosauria',
      interval: 'Maastrichtian',
      lngmin: -120,
      lngmax: -100,
      latmin: 40,
      latmax: 60,
      lithology: 'sandstone',
      environment: 'terrestrial',
      limit: 50,
      offset: 100,
    });
  });

  it('format() renders ids, age, strata, lithology, and environment', () => {
    const out = searchCollectionsTool.output.parse({ collections: [hellCreek] });
    const text = renderText(searchCollectionsTool.format?.(out));
    expect(text).toContain('collection_no:** 11917');
    expect(text).toContain('Late Maastrichtian');
    expect(text).toContain('formation Scollard');
    expect(text).toContain('lithology:** sandstone');
    expect(text).toContain('environment:** channel');
    expect(text).toContain('modern coords:** 51.9064, -113.0289');
  });

  it('format() preserves uncertainty on a sparse locality', () => {
    const sparse: Collection = { collection_no: 200, early_interval: 'Jurassic' };
    const out = searchCollectionsTool.output.parse({ collections: [sparse] });
    const text = renderText(searchCollectionsTool.format?.(out));
    expect(text).toContain('collection_no:** 200');
    expect(text).toContain('modern coords:** unknown');
    // No invented lithology/environment lines for a sparse locality.
    expect(text).not.toContain('lithology:**');
    expect(text).not.toContain('environment:**');
  });
});

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
