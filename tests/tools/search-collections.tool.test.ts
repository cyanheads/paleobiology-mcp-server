/**
 * @fileoverview Handler tests for paleobiology_search_collections. Covers the
 * happy path, the empty-result path (required-field-on-empty: { collections: []
 * } still validates, with a notice), pagination against PBDB's true match count
 * (the page numbered from offset, and no remainder claimed on a final page that
 * exactly fills the limit), the ignored-filter warning disclosure on a full
 * unfiltered result, the filter → service mapping, blank form-client filters read
 * as unset, the declared recovery for a filter PBDB rejected, the inline response
 * budget (a page cut to fit, the 500-row draw cap, an offset walk with no gaps or
 * repeats), format() parity with upstream line breaks flattened, and a sparse
 * locality.
 *
 * The PBDB layer is never hit: getPbdbService().searchCollections is a per-test
 * fake returning the CollectionResult the service would.
 * @module tests/tools/search-collections.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, CollectionFilter, CollectionResult } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';
import { surfaceBytes } from '../helpers/surface-bytes.js';

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
    const err = await expectMcpError(() => searchCollectionsTool.handler(input, ctx));
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
      const err = await expectMcpError(() => searchCollectionsTool.handler(input, ctx));
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
      const err = await expectMcpError(() => searchCollectionsTool.handler(input, ctx));
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

  it('renders an exhausted page neutrally; the offset notice alone explains it (#24)', async () => {
    searchCollections.mockResolvedValue(result([], { cap: 500, offset: 999, total: 591 }));
    const result_ = await runToolContract(searchCollectionsTool, {
      formation: 'Hell Creek',
      limit: 500,
      offset: 999,
    });

    expect(result_.isError).toBeFalsy();
    const text = renderText(result_.content as { type: string; text?: string }[]);
    expect(text).toContain('**0 locality(ies)**');
    expect(text).not.toContain('No fossil collections matched');
    expect(text).toContain(
      'Offset 999 is past the end of the 591 matching localities. Lower offset to below 591 — the filters themselves matched.',
    );
    expect(result_.structuredContent).toMatchObject({
      collections: [],
      totalCount: 591,
      notice: expect.stringContaining('Offset 999 is past the end of the 591 matching localities.'),
    });
  });

  it('keeps the no-match notice on a search that matched nothing (#24)', async () => {
    searchCollections.mockResolvedValue(result([], { cap: 100, offset: 0, total: 0 }));
    const result_ = await runToolContract(searchCollectionsTool, { formation: 'Nowhere' });

    const text = renderText(result_.content as { type: string; text?: string }[]);
    expect(text).toContain('**0 locality(ies)**');
    expect(text).toContain('No localities matched the filters.');
    expect(result_.structuredContent).toMatchObject({
      notice: expect.stringContaining('No localities matched the filters.'),
    });
  });

  it('declares a recovery for a filter value PBDB rejected (#24)', async () => {
    searchCollections.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        "PBDB rejected the searchCollections query: there are no records with lithology or lithology type 'unobtainium' in the database; You must specify 'all_records' if you want to retrieve the entire set of records.",
        { operation: 'searchCollections', reason: 'pbdb_invalid_parameter' },
      ),
    );
    const result_ = await runToolContract(searchCollectionsTool, {
      lithology: 'unobtainium',
      limit: 2,
    });

    expect(result_.isError).toBe(true);
    const error = (result_.structuredContent as { error: { message: string; data: unknown } })
      .error;
    expect(error.message).toBe(
      "PBDB rejected the searchCollections query: there are no records with lithology or lithology type 'unobtainium' in the database; You must specify 'all_records' if you want to retrieve the entire set of records.",
    );
    expect(error.data).toMatchObject({
      reason: 'pbdb_invalid_parameter',
      recovery: {
        hint: 'Correct the value PBDB named in the message — confirm an interval name with paleobiology_list_intervals or a taxon name with paleobiology_get_taxon, and check a formation or lithology spelling — or replace that filter with another one (a max_ma/min_ma range for an interval, base_id for a taxon), then retry.',
      },
    });
  });

  describe('blank optional inputs (#22)', () => {
    it('reads a blank formation as unset: missing_filter, no PBDB request', async () => {
      const result_ = await runToolContract(searchCollectionsTool, { formation: '' });

      expect(result_.isError).toBe(true);
      expect(result_.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'missing_filter',
            recovery: {
              hint: 'Provide at least one filter: base_name or base_id, an interval or max_ma/min_ma range, a lng/lat bounding box, a formation or lithology, or an environment — then retry.',
            },
          },
        },
      });
      expect(searchCollections).not.toHaveBeenCalled();
    });

    it('filters by base_id alone and drops every blank or whitespace filter', async () => {
      searchCollections.mockResolvedValue(result([hellCreek]));
      const result_ = await runToolContract(searchCollectionsTool, {
        base_name: '',
        base_id: 38613,
        interval: ' ',
        formation: '',
        lithology: '\n',
        environment: '' as never,
      });

      expect(result_.isError).toBeFalsy();
      expect(searchCollections).toHaveBeenCalledWith(
        { limit: 100, offset: 0, baseId: 38613 },
        expect.anything(),
      );
    });
  });

  describe('inline response budget (#23)', () => {
    const BUDGET = 100_000;
    const fixture = Array.from({ length: 1200 }, (_, i) => ({
      ...hellCreek,
      collection_no: i + 1,
    }));

    /** Serve slices of the fixture the way the service pages PBDB. */
    function servePages(): { filters: CollectionFilter[] } {
      const seen: { filters: CollectionFilter[] } = { filters: [] };
      searchCollections.mockImplementation(async (filter: CollectionFilter) => {
        seen.filters.push(filter);
        const rows = fixture.slice(filter.offset, filter.offset + filter.limit);
        return result(rows, {
          offset: filter.offset,
          cap: filter.limit,
          total: fixture.length,
          truncated: filter.offset + rows.length < fixture.length,
        });
      });
      return seen;
    }

    it('cuts a full page to the budget and discloses it as truncated', async () => {
      servePages();
      const result_ = await runToolContract(searchCollectionsTool, {
        formation: 'Hell Creek',
        limit: 500,
      });

      const bytes = surfaceBytes(result_);
      expect(bytes.structured).toBeLessThanOrEqual(BUDGET);
      expect(bytes.text).toBeLessThanOrEqual(BUDGET);
      const structured = result_.structuredContent as {
        collections: Collection[];
        truncated: boolean;
        shown: number;
        cap: number;
        totalCount: number;
        notice: string;
      };
      const shown = structured.collections.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(500);
      expect(structured).toMatchObject({ truncated: true, shown, cap: 500, totalCount: 1200 });
      expect(structured.notice).toBe(
        `Showing localities 1–${shown} of 1200. This page was cut to ${shown} of the 500 pulled to fit the inline response size. Advance offset to ${shown} for the next page.`,
      );
      const text = renderText(result_.content as { type: string; text?: string }[]);
      expect(text).toContain(`**${shown} locality(ies)**`);
      expect(text.split('\n### ').length - 1).toBe(shown);
    });

    it('serves a limit above 500 at the 500 cap and names it', async () => {
      const seen = servePages();
      const result_ = await runToolContract(searchCollectionsTool, {
        formation: 'Hell Creek',
        limit: 600,
        offset: 1100,
      });

      expect(result_.isError).toBeFalsy();
      expect(seen.filters[0]?.limit).toBe(500);
      // 100 rows remain from offset 1100, so the cap did not bind: no remainder, no notice.
      expect((result_.structuredContent as { notice?: string }).notice).toBeUndefined();

      const capped = await runToolContract(searchCollectionsTool, {
        formation: 'Hell Creek',
        limit: 600,
      });
      expect((capped.structuredContent as { notice: string }).notice).toContain(
        'limit 600 is above the per-call cap of 500, so this page drew from at most 500 localities.',
      );
    });

    it('rejects a limit above the 10,000 ceiling at the schema', async () => {
      const result_ = await runToolContract(searchCollectionsTool, {
        formation: 'Hell Creek',
        limit: 10_001,
      });
      expect(result_.isError).toBe(true);
      expect(result_.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('limit: Too big: expected number to be <=10000'),
        },
      });
      expect(searchCollections).not.toHaveBeenCalled();
    });

    it('walks the match set by the named offsets with no gaps or repeats', async () => {
      servePages();
      const seen: number[] = [];
      let offset = 0;
      let pages = 0;
      for (;;) {
        const result_ = await runToolContract(searchCollectionsTool, {
          formation: 'Hell Creek',
          limit: 500,
          offset,
        });
        const bytes = surfaceBytes(result_);
        expect(Math.max(bytes.structured, bytes.text)).toBeLessThanOrEqual(BUDGET);
        const structured = result_.structuredContent as {
          collections: Collection[];
          notice?: string;
        };
        seen.push(...structured.collections.map((c) => c.collection_no));
        pages += 1;
        const next = /Advance offset to (\d+)/.exec(structured.notice ?? '')?.[1];
        if (!next) break;
        expect(Number(next)).toBe(offset + structured.collections.length);
        offset = Number(next);
      }
      expect(pages).toBeGreaterThan(3);
      expect(seen).toEqual(fixture.map((c) => c.collection_no));
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

  it('keeps line breaks in PBDB text on their content[] line and verbatim in structuredContent (#33)', async () => {
    const row: Collection = {
      collection_no: 11917,
      collection_name: "Knudsen's\n### Forged",
      lng: -113,
      lat: 51.9,
      early_interval: 'Late\r\nMaastrichtian',
      late_interval: 'Danian\n- forged',
      max_ma: 72.2,
      min_ma: 66,
      formation: 'Hell Creek\n### Forged',
      geological_group: 'Montana\rGroup',
      member: 'Upper\n\nmember',
      lithology: 'sandstone\n> forged',
      lithology_description: 'channel\r\n\r\nsandstone',
      environment: 'channel\n**forged:** x',
      cc: 'US\n',
      state: 'Montana\r',
      county: 'Garfield\nCounty',
      n_occs: 12,
      reference_no: 4218,
    };
    searchCollections.mockResolvedValue(result([row]));
    const result_ = await runToolContract(searchCollectionsTool, { formation: 'Hell Creek' });

    expect(
      (result_.structuredContent as { collections: Collection[] }).collections[0],
    ).toStrictEqual(row);
    const text = renderText(result_.content as { type: string; text?: string }[]);
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/^(#+|-|>) ?[Ff]orged/m);
    expect(text).toContain(
      [
        "### Knudsen's ### Forged",
        '**collection_no:** 11917 | **occurrences:** 12',
        '**age:** Late Maastrichtian – Danian - forged (72.2–66 Ma)',
        '**strata:** formation Hell Creek ### Forged, group Montana Group, member Upper member',
        '**lithology:** sandstone > forged — channel sandstone',
        '**environment:** channel **forged:** x',
        '**modern coords:** 51.9, -113',
        '**locality:** Garfield County, Montana, US',
        '**reference_no:** 4218',
      ].join('\n'),
    );
  });
});

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
