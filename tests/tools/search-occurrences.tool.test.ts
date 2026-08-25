/**
 * @fileoverview Handler tests for paleobiology_search_occurrences — the flagship.
 * Covers the canvas-disabled inline path (including the required-field-on-empty
 * regression: a zero-result return must still carry spilled/row_count and
 * validate against the output schema), the true-total disclosure (the exact
 * remainder against PBDB's match count, and no remainder claimed when the page
 * IS the whole set), the ignored-filter and unmatched-name warning notices, the
 * canvas-enabled non-spilled and spilled branches (canvas_id is returned only on
 * the spill path — an inline result stages nothing), the cross-field boundary
 * guards (lngmin/lngmax both-or-neither, min_ma strictly below max_ma, both
 * rejected before any PBDB call), the environment-enum → filter mapping,
 * format() parity (modern vs paleo coords, classification), and sparse rows.
 *
 * Neither PBDB nor DuckDB is hit: getPbdbService() yields the `{ rows, meta }`
 * search handle over fake rows, and getCanvas() returns a fake DataCanvas whose
 * acquired instance stands in for the real spill target.
 * @module tests/tools/search-occurrences.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Occurrence, OccurrenceFilter, PbdbSearchMeta } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';

const searchOccurrences = vi.fn();
const getCanvas = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ searchOccurrences }) };
});
vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas, setCanvas: () => {} }));

const { searchOccurrencesTool } = await import(
  '@/mcp-server/tools/definitions/search-occurrences.tool.js'
);

/** Turn an array of rows into the async generator the handler consumes. */
async function* rowGen(rows: Occurrence[]): AsyncGenerator<Occurrence> {
  for (const r of rows) yield r;
}

/**
 * Make searchOccurrences hand back these rows plus the upstream metadata that
 * rides on the handle — `recordsFound` (PBDB's true match count) and `warnings`.
 * An empty meta stands for an envelope with no rowcount block.
 */
function stubRows(rows: Occurrence[], meta: PbdbSearchMeta = {}): void {
  searchOccurrences.mockImplementation((_filter: OccurrenceFilter) => ({
    rows: rowGen(rows),
    meta,
  }));
}

const tRex: Occurrence = {
  occurrence_no: 139292,
  collection_no: 11917,
  accepted_name: 'Tyrannosaurus rex',
  accepted_rank: 'species',
  accepted_no: 54833,
  early_interval: 'Late Maastrichtian',
  max_ma: 72.2,
  min_ma: 66,
  lng: -113.0289,
  lat: 51.9064,
  paleolng: -68.22,
  paleolat: 64.06,
  paleomodel: 'gplates',
  formation: 'Scollard',
  cc: 'CA',
  reference_no: 4218,
};

describe('paleobiology_search_occurrences (canvas disabled)', () => {
  beforeEach(() => {
    searchOccurrences.mockReset();
    getCanvas.mockReset();
    getCanvas.mockReturnValue(undefined); // canvas disabled
  });

  it('returns occurrences inline and conforms to the output schema', async () => {
    stubRows([tRex]);
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus' });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result.spilled).toBe(false);
    expect(result.row_count).toBe(1);
    expect(result.canvas_id).toBeUndefined();
    expect(result.occurrences[0]).toMatchObject({ occurrence_no: 139292 });
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
  });

  it('populates every required output field on an EMPTY result (no canvas)', async () => {
    stubRows([]);
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Nothingium' });
    const result = await searchOccurrencesTool.handler(input, ctx);

    // The empty path must still validate — spilled + row_count present, not dropped.
    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result).toMatchObject({ occurrences: [], spilled: false, row_count: 0 });
    // And the agent gets an actionable empty notice echoing the filter.
    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(0);
    expect(String(enr.notice)).toMatch(/No occurrences matched Nothingium/);
    // #3: notice AND attribution are enrichment fields — the framework renders both
    // into content[] as a trailer, so content[]-only clients see the guidance + source.
    expect(String(enr.attribution)).toMatch(/Paleobiology Database/);
  });

  it('names the page range and the next offset against the true match count (#13, #14)', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...tRex, occurrence_no: i + 1 }));
    stubRows(rows, { recordsFound: 4170 });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 2 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.row_count).toBe(2);
    const enr = getEnrichment(ctx);
    // totalCount is the upstream match count, not the returned page size.
    expect(enr.totalCount).toBe(4170);
    // Advancing offset is the primary next step — exact page bounds, exact next offset.
    expect(String(enr.notice)).toContain('Showing occurrences 1–2 of 4170.');
    expect(String(enr.notice)).toContain('Advance offset to 2 for the next page.');
    expect(String(enr.notice)).toContain('Or raise limit (max 500) to pull more per page.');
    expect(String(enr.notice)).toMatch(/CANVAS_PROVIDER_TYPE=duckdb/);
  });

  it('threads offset into the service filter and reports the second page (#14)', async () => {
    let captured: OccurrenceFilter | undefined;
    const page2 = Array.from({ length: 2 }, (_, i) => ({ ...tRex, occurrence_no: 100 + i }));
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen(page2), meta: { recordsFound: 87 } };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 2,
      offset: 4,
    });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(captured).toMatchObject({ baseName: 'Tyrannosaurus', limit: 2, offset: 4 });
    expect(result.occurrences.map((o) => o.occurrence_no)).toEqual([100, 101]);
    const notice = String(getEnrichment(ctx).notice);
    // Page numbers are absolute against the match set, not 1-based within the page.
    expect(notice).toContain('Showing occurrences 5–6 of 87.');
    expect(notice).toContain('Advance offset to 6 for the next page.');
  });

  it('defaults offset to 0 and omits the paging notice on the final page (#14)', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen([tRex, { ...tRex, occurrence_no: 2 }]), meta: { recordsFound: 6 } };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 2,
      offset: 4,
    });
    await searchOccurrencesTool.handler(input, ctx);

    expect(captured?.offset).toBe(4);
    // offset 4 + 2 rows === the 6 upstream matches: nothing left, so no next-page advice.
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(searchOccurrencesTool.input.parse({ base_name: 'X' }).offset).toBe(0);
  });

  it('reports the overshoot when offset ran past the end of a real match set (#14)', async () => {
    // An empty page past the end is a paging mistake, not a too-narrow filter —
    // the notice must not send the agent off to widen filters that DID match.
    stubRows([], { recordsFound: 87 });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 10,
      offset: 200,
    });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toMatchObject({ occurrences: [], spilled: false, row_count: 0 });
    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(87);
    const notice = String(enr.notice);
    expect(notice).toBe(
      'Offset 200 is past the end of the 87 matching occurrences. ' +
        'Lower offset to below 87 — the filters themselves matched.',
    );
    expect(notice).not.toContain('widen');
    expect(notice).not.toContain('Verify the taxon name');
  });

  it('never advises raising limit when limit is already at its maximum (#14)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ ...tRex, occurrence_no: i + 1 }));
    stubRows(rows, { recordsFound: 4170 });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    await searchOccurrencesTool.handler(input, ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Showing occurrences 1–500 of 4170.');
    expect(notice).toContain('Advance offset to 500 for the next page.');
    // The pre-#14 copy told the agent to raise a limit that was already maxed.
    expect(notice).not.toContain('raise limit');
  });

  it('claims no remainder when the returned page IS every match', async () => {
    // The old `rows.length >= cap` heuristic fired here: a page that exactly fills
    // the limit with nothing left upstream. The true total says otherwise.
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...tRex, occurrence_no: i + 1 }));
    stubRows(rows, { recordsFound: 2 });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 2 });
    await searchOccurrencesTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(2);
    expect(enr.notice).toBeUndefined();
  });

  it('discloses that PBDB ignored a filter it could not resolve (#12)', async () => {
    // The silent-correctness case: PBDB dropped the unrecognized value and returned
    // the FULL unfiltered set, so a non-empty result here is NOT a match on it.
    stubRows([tRex], {
      recordsFound: 1,
      warnings: [
        "there are no records with lithology or lithology type 'garbagexyz' in the database",
      ],
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria' });
    await searchOccurrencesTool.handler(input, ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('PBDB could not use part of this query');
    expect(notice).toContain("lithology or lithology type 'garbagexyz'");
    expect(notice).toContain('That filter did not constrain the result');
  });

  it('separates an unmatched taxon name from a genuinely empty result (#12)', async () => {
    stubRows([], {
      recordsFound: 0,
      warnings: [
        "The name 'Tyrannosauruss' did not match the currently accepted variant of any name in the taxonomy table",
      ],
    });
    const typoCtx = createMockContext({ errors: searchOccurrencesTool.errors });
    await searchOccurrencesTool.handler(
      searchOccurrencesTool.input.parse({ base_name: 'Tyrannosauruss' }),
      typoCtx,
    );
    const typoNotice = String(getEnrichment(typoCtx).notice);
    expect(typoNotice).toContain("The name 'Tyrannosauruss' did not match");

    stubRows([], { recordsFound: 0 });
    const emptyCtx = createMockContext({ errors: searchOccurrencesTool.errors });
    await searchOccurrencesTool.handler(
      searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus', interval: 'Cambrian' }),
      emptyCtx,
    );
    const emptyNotice = String(getEnrichment(emptyCtx).notice);
    expect(emptyNotice).not.toContain('did not match');
    expect(emptyNotice).not.toContain('PBDB could not use');
    expect(emptyNotice).toContain('No occurrences matched Tyrannosaurus in Cambrian');
    // The two notices must be distinguishable — that is the whole point of the fix.
    expect(typoNotice).not.toBe(emptyNotice);
  });

  it('rejects an unfiltered call before hitting PBDB (missing_filter)', async () => {
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    for (const raw of [{}, { limit: 3 }]) {
      const input = searchOccurrencesTool.input.parse(raw);
      await expect(searchOccurrencesTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'missing_filter' },
      });
    }
    // PBDB must never be called when no selector was supplied.
    expect(searchOccurrences).not.toHaveBeenCalled();
  });

  it('rejects a half-specified longitude box before hitting PBDB (incomplete_bbox)', async () => {
    // PBDB answers a lone lngmin/lngmax with HTTP 400 + errors[], which used to
    // reach the agent as a NotFound with no recovery. Guard it at the boundary.
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    for (const raw of [
      { base_name: 'Canis', lngmin: -130 },
      { base_name: 'Canis', lngmax: -60 },
    ]) {
      const input = searchOccurrencesTool.input.parse(raw);
      const err = await expectMcpError(() => searchOccurrencesTool.handler(input, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data?.reason).toBe('incomplete_bbox');
      expect(JSON.stringify(err.data)).toMatch(/lngmin AND lngmax/);
    }
    expect(searchOccurrences).not.toHaveBeenCalled();
  });

  it('accepts a complete longitude box and a lone latitude edge', async () => {
    // A latitude half-plane is valid at PBDB and must keep working; an inverted
    // latitude box is normalized upstream, so no ordering guard applies there.
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen([tRex]), meta: {} };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    for (const raw of [
      { base_name: 'Canis', latmin: 80 },
      { base_name: 'Canis', lngmin: -130, lngmax: -60 },
      { base_name: 'Canis', latmin: 80, latmax: 10 },
    ]) {
      const input = searchOccurrencesTool.input.parse(raw);
      await expect(searchOccurrencesTool.handler(input, ctx)).resolves.toBeDefined();
    }
    expect(captured).toMatchObject({ latmin: 80, latmax: 10 });
  });

  it('rejects an inverted or empty Ma window before hitting PBDB (inverted_ma_range)', async () => {
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    for (const raw of [
      { base_name: 'Tyrannosaurus', max_ma: 66, min_ma: 100 },
      { base_name: 'Tyrannosaurus', max_ma: 66, min_ma: 66 },
    ]) {
      const input = searchOccurrencesTool.input.parse(raw);
      const err = await expectMcpError(() => searchOccurrencesTool.handler(input, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data?.reason).toBe('inverted_ma_range');
      expect(JSON.stringify(err.data)).toMatch(/strictly less than max_ma/);
    }
    expect(searchOccurrences).not.toHaveBeenCalled();
  });

  it('accepts a Ma window with min_ma below max_ma', async () => {
    stubRows([tRex]);
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      max_ma: 100,
      min_ma: 66,
    });
    await expect(searchOccurrencesTool.handler(input, ctx)).resolves.toMatchObject({
      row_count: 1,
    });
  });

  it('surfaces the classification the service already fetched on each row', async () => {
    // PBDB's `class` show block is requested and normalized, and the canvas stages
    // it — the tool's own rows must carry it too, on both output surfaces.
    stubRows([
      {
        ...tRex,
        classification: {
          phylum: 'Chordata',
          class: 'Reptilia',
          family: 'Tyrannosauridae',
          genus: 'Tyrannosaurus',
        },
      },
    ]);
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus', limit: 1 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result.occurrences[0]?.classification).toEqual({
      phylum: 'Chordata',
      class: 'Reptilia',
      family: 'Tyrannosauridae',
      genus: 'Tyrannosaurus',
    });
    const text = renderText(searchOccurrencesTool.format?.(result));
    expect(text).toContain(
      'classification:** phylum: Chordata › class: Reptilia › family: Tyrannosauridae › genus: Tyrannosaurus',
    );
  });

  it('omits the classification line when PBDB resolved no ranks', async () => {
    stubRows([tRex]); // tRex fixture carries no classification
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus' });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.occurrences[0]).not.toHaveProperty('classification');
    expect(renderText(searchOccurrencesTool.format?.(result))).not.toContain('classification:**');
  });

  it('accepts base_id as a sole filter and maps it to the service (#20)', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen([tRex]), meta: { recordsFound: 87 } };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_id: 38613 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    // base_id alone satisfies the missing-filter guard and reaches the service.
    expect(captured).toMatchObject({ baseId: 38613 });
    expect(captured).not.toHaveProperty('baseName');
    expect(result.row_count).toBe(1);
    expect(getEnrichment(ctx).totalCount).toBe(87);
  });

  it('rejects base_name + base_id together at the boundary (#20)', async () => {
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      base_id: 38613,
    });
    const err = await expectMcpError(() => searchOccurrencesTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data?.reason).toBe('conflicting_taxon_filter');
    expect(err.message).toBe(
      'Got base_name "Tyrannosaurus" and base_id 38613 — PBDB accepts only one clade selector.',
    );
    expect(JSON.stringify(err.data)).toMatch(/Send base_id alone/);
    // Guarded locally — PBDB's own HTTP 400 is never reached.
    expect(searchOccurrences).not.toHaveBeenCalled();
  });

  it('names the taxon id in the empty notice when the filter was base_id (#20)', async () => {
    stubRows([], { recordsFound: 0 });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_id: 38613, interval: 'Cambrian' });
    await searchOccurrencesTool.handler(input, ctx);

    expect(String(getEnrichment(ctx).notice)).toContain(
      'No occurrences matched taxon_no 38613 in Cambrian.',
    );
  });

  it('accepts collection_no as a sole filter and maps it to the service (drilldown)', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen([tRex]), meta: {} };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ collection_no: 11917 });
    await searchOccurrencesTool.handler(input, ctx);
    // collection_no alone satisfies the missing-filter guard and reaches the service.
    expect(captured).toMatchObject({ collectionNo: 11917 });
  });

  it('maps the environment enum to the service filter (freshwater)', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen([]), meta: {} };
    });
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Dinosauria',
      environment: 'freshwater',
      max_ma: 100,
      min_ma: 66,
    });
    await searchOccurrencesTool.handler(input, ctx);
    // The handler passes the agent-facing enum through; the service maps it to PBDB envtype.
    expect(captured).toMatchObject({
      baseName: 'Dinosauria',
      environment: 'freshwater',
      maxMa: 100,
      minMa: 66,
    });
  });

  it('format() renders modern AND paleo coordinates distinctly', () => {
    const out = searchOccurrencesTool.output.parse({
      occurrences: [tRex],
      spilled: false,
      row_count: 1,
    });
    const text = renderText(searchOccurrencesTool.format?.(out));
    expect(text).toContain('occurrence_no:** 139292');
    expect(text).toContain('modern coords:** 51.9064, -113.0289');
    expect(text).toContain('paleo coords:** 64.06, -68.22 [gplates]');
    expect(text).toContain('Late Maastrichtian');
  });

  it('format() preserves uncertainty on a sparse row (no paleo reconstruction)', () => {
    const sparse: Occurrence = {
      occurrence_no: 500,
      accepted_name: 'Some taxon',
      early_interval: 'Cambrian',
      max_ma: 500,
      min_ma: 485,
    };
    const out = searchOccurrencesTool.output.parse({
      occurrences: [sparse],
      spilled: false,
      row_count: 1,
    });
    const text = renderText(searchOccurrencesTool.format?.(out));
    expect(text).toContain('modern coords:** unknown');
    expect(text).toContain('paleo coords:** unknown (no reconstruction)');
  });

  it('format() renders a header-only block for an empty result', () => {
    const out = searchOccurrencesTool.output.parse({
      occurrences: [],
      spilled: false,
      row_count: 0,
    });
    const text = renderText(searchOccurrencesTool.format?.(out));
    expect(text).toContain('0 occurrence(s)');
  });
});

describe('paleobiology_search_occurrences (canvas enabled)', () => {
  beforeEach(() => {
    searchOccurrences.mockReset();
    getCanvas.mockReset();
  });

  it('omits canvas_id (and the format header clause) when the result did not spill', async () => {
    // Nothing is staged on a non-spilling call, so returning canvas_id would point
    // the agent at an empty canvas — it is gated on `spilled`, same as table_name.
    stubRows([tRex]);
    const instance = makeFakeInstance('canvasAbc01');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus' });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(result.row_count).toBe(1);
    // registerTable must NOT be called when the source fits the preview budget.
    expect(instance.registerTable).not.toHaveBeenCalled();
    // content[]-only clients must not be pointed at the canvas either.
    const text = renderText(searchOccurrencesTool.format?.(result));
    expect(text).toContain('(spilled: no)');
    expect(text).not.toContain('canvasAbc01');
    expect(text).not.toContain('canvas');
  });

  it('spills a large result to the canvas and reports table_name + staged row_count', async () => {
    // Build rows whose serialized size exceeds previewChars (100_000) so spillover
    // registers the full set on the canvas instead of inlining it.
    const big = Array.from({ length: 400 }, (_, i) => ({
      ...tRex,
      occurrence_no: i + 1,
      formation: 'X'.repeat(300),
    }));
    stubRows(big);
    const instance = makeFakeInstance('canvasXyz02');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('canvasXyz02');
    expect(result.table_name).toBe('occurrences_canvasXyz02');
    expect(result.row_count).toBe(400);
    expect(instance.registerTable).toHaveBeenCalledOnce();
    // The spill notice points the agent at the dataframe query tool.
    expect(String(getEnrichment(ctx).notice)).toMatch(/paleobiology_dataframe_query/);
    // The staged 400 rows ARE every match upstream — claim no shortfall.
    expect(getEnrichment(ctx).totalCount).toBe(400);
    expect(String(getEnrichment(ctx).notice)).not.toMatch(/unstaged/);
  });

  it('names the next page on a spilled set that is only part of the match set (#6, #13, #14)', async () => {
    // Yield exactly `limit` rows so the staged count equals the per-call cap while
    // PBDB reports many more — the canvas holds a page, not the set, and the notice
    // must say which page and how to reach the next rather than implying completeness.
    const capped = Array.from({ length: 500 }, (_, i) => ({
      ...tRex,
      occurrence_no: i + 1,
      formation: 'X'.repeat(300),
    }));
    stubRows(capped, { recordsFound: 4170 });
    const instance = makeFakeInstance('canvasCap03');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.row_count).toBe(500);
    const enr = getEnrichment(ctx);
    expect(enr.totalCount).toBe(4170);
    const notice = String(enr.notice);
    expect(notice).toContain('Staged 500 matching occurrences on canvas canvasCap03');
    expect(notice).toContain('Showing occurrences 1–500 of 4170.');
    expect(notice).toContain('Advance offset to 500 for the next page.');
  });

  it('pages a spilled set: offset 500 stages the second page and points at the third (#14)', async () => {
    let captured: OccurrenceFilter | undefined;
    const capped = Array.from({ length: 500 }, (_, i) => ({
      ...tRex,
      occurrence_no: 500 + i,
      formation: 'X'.repeat(300),
    }));
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: rowGen(capped), meta: { recordsFound: 4170 } };
    });
    const instance = makeFakeInstance('canvasPg04');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Dinosauria',
      limit: 500,
      offset: 500,
    });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(captured?.offset).toBe(500);
    expect(result.spilled).toBe(true);
    expect(result.row_count).toBe(500);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Showing occurrences 501–1000 of 4170.');
    expect(notice).toContain('Advance offset to 1000 for the next page.');
  });

  it('sanitizes a hyphenated canvas id into a legal SQL table identifier', async () => {
    // The canvas mints ids from nanoid's URL-safe alphabet, which includes "-".
    // A raw `occurrences_<id>` table name with a hyphen is an illegal SQL
    // identifier and the canvas rejects it — the id portion must be sanitized.
    const big = Array.from({ length: 400 }, (_, i) => ({
      ...tRex,
      occurrence_no: i + 1,
      formation: 'X'.repeat(300),
    }));
    stubRows(big);
    const instance = makeFakeInstance('a-VBpZv9G');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.table_name).toBe('occurrences_a_VBpZv9G');
    expect(result.table_name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('reuses an explicit canvas_id passed by the caller', async () => {
    stubRows([tRex]);
    const acquire = vi.fn().mockResolvedValue(makeFakeInstance('reusedId03'));
    getCanvas.mockReturnValue({ acquire });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      canvas_id: 'reusedId03',
    });
    await searchOccurrencesTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('reusedId03', ctx);
  });
});

/**
 * A fake CanvasInstance covering the methods spillover() + the handler touch.
 * spillover() hands registerTable an async generator of rows (preview + sentinel
 * + tail), so the fake drains it to count — mirroring a real provider ingesting
 * every row and reporting the total back as rowCount.
 */
function makeFakeInstance(canvasId: string) {
  return {
    canvasId,
    tenantId: 'default',
    isNew: true,
    registerTable: vi.fn(
      async (
        name: string,
        rows: Record<string, unknown>[] | AsyncIterable<Record<string, unknown>>,
      ) => {
        let rowCount = 0;
        let first: Record<string, unknown> | undefined;
        for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
          first ??= row;
          rowCount += 1;
        }
        return { tableName: name, rowCount, columns: Object.keys(first ?? {}) };
      },
    ),
  };
}

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
