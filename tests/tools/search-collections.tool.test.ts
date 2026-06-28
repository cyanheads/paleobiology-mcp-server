/**
 * @fileoverview Handler tests for paleobiology_search_collections. Covers the
 * happy path, the empty-result path (required-field-on-empty: { collections: []
 * } still validates, with a notice), pagination/truncation disclosure (the page
 * filled to the limit → ctx.enrich.truncated with shown/cap), the filter →
 * service mapping, format() parity, and a sparse locality.
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

/** Build the CollectionResult the service returns for a given page of rows. */
function result(rows: Collection[], cap = 100, truncated = false): CollectionResult {
  return { collections: rows, shown: rows.length, truncated, cap };
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

  it('discloses truncation (shown/cap) when the page fills to the limit', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...hellCreek, collection_no: i + 1 }));
    searchCollections.mockResolvedValue(result(rows, 2, true));
    const ctx = createMockContext({ errors: searchCollectionsTool.errors });
    const input = searchCollectionsTool.input.parse({ base_name: 'Dinosauria', limit: 2 });
    await searchCollectionsTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    // enrich.truncated sets truncated/shown/cap and routes guidance through notice.
    expect(enr).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(String(enr.notice ?? '')).toMatch(/Advance offset by 2/);
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
