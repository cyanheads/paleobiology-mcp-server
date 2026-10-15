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
 * format() parity (modern vs paleo coords, classification), sparse rows, blank
 * optional inputs, canvas-slot handling, and the inline response budget.
 *
 * Neither PBDB nor DuckDB is hit: getPbdbService().searchOccurrences resolves
 * `{ rows, meta }` over fake rows, and getCanvas() returns a fake DataCanvas whose
 * acquired instance stands in for the real spill target.
 * @module tests/tools/search-occurrences.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Occurrence, OccurrenceFilter, PbdbSearchMeta } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';
import { surfaceBytes } from '../helpers/surface-bytes.js';

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

/**
 * Make searchOccurrences hand back these rows plus the upstream metadata that
 * rides alongside them — `recordsFound` (PBDB's true match count) and `warnings`.
 * An empty meta stands for an envelope with no rowcount block.
 */
function stubRows(rows: Occurrence[], meta: PbdbSearchMeta = {}): void {
  searchOccurrences.mockResolvedValue({ rows, meta });
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
    // A page the inline budget never cut has nothing to stage, canvas or not.
    expect(String(enr.notice)).not.toMatch(/DataCanvas|CANVAS_PROVIDER_TYPE/);
  });

  it('threads offset into the service filter and reports the second page (#14)', async () => {
    let captured: OccurrenceFilter | undefined;
    const page2 = Array.from({ length: 2 }, (_, i) => ({ ...tRex, occurrence_no: 100 + i }));
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: page2, meta: { recordsFound: 87 } };
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
      return { rows: [tRex, { ...tRex, occurrence_no: 2 }], meta: { recordsFound: 6 } };
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
    // Bare rows keep the full 500-row page inside the inline response budget, so
    // `limit` (not the budget) is what bounded it.
    const rows = Array.from({ length: 500 }, (_, i) => ({ occurrence_no: i + 1 }));
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
      return { rows: [tRex], meta: {} };
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
      return { rows: [tRex], meta: { recordsFound: 87 } };
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
      return { rows: [tRex], meta: {} };
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
      return { rows: [], meta: {} };
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

  describe('blank optional inputs (#22)', () => {
    /** Capture the filter the handler hands the service, answering with one row. */
    function captureFilter(): { filter?: OccurrenceFilter } {
      const seen: { filter?: OccurrenceFilter } = {};
      searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
        seen.filter = filter;
        return { rows: [tRex], meta: {} };
      });
      return seen;
    }

    it.each(['', '   '])(
      'reads base_name %j as unset: missing_filter with recovery, no PBDB request',
      async (blank) => {
        const result = await runToolContract(searchOccurrencesTool, { base_name: blank, limit: 2 });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            data: {
              reason: 'missing_filter',
              recovery: {
                hint: 'Provide at least one filter: base_name, base_id, or taxon_name, an interval or max_ma/min_ma range, a lng/lat bounding box, an environment, or a collection_no — then retry.',
              },
            },
          },
        });
        expect(searchOccurrences).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['blank', ''],
      ['null', null],
    ])('filters by base_id alone when base_name arrives %s', async (_label, base_name) => {
      const seen = captureFilter();
      const result = await runToolContract(searchOccurrencesTool, {
        base_name,
        base_id: 38613,
      } as never);

      expect(result.isError).toBeFalsy();
      expect(seen.filter).toEqual({ limit: 100, offset: 0, baseId: 38613 });
    });

    it('sends no blank or whitespace filter to PBDB, environment and canvas_id included', async () => {
      const seen = captureFilter();
      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Dinosauria',
        taxon_name: ' ',
        interval: '\t',
        environment: '' as never,
        canvas_id: '',
      });

      expect(result.isError).toBeFalsy();
      expect(seen.filter).toEqual({ limit: 100, offset: 0, baseName: 'Dinosauria' });
    });
  });

  it('declares a recovery for a filter value PBDB rejected (#24)', async () => {
    searchOccurrences.mockImplementation(() => {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        "PBDB rejected the searchOccurrences query: Unknown interval 'Foobarian'; No valid interval names were given.",
        { operation: 'searchOccurrences', reason: 'pbdb_invalid_parameter' },
      );
    });
    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      interval: 'Foobarian',
      limit: 2,
    });

    const hint =
      'Correct the value PBDB named in the message — confirm an interval name with paleobiology_list_intervals or a taxon name with paleobiology_get_taxon — or replace that filter with another one (a max_ma/min_ma range for an interval, base_id for a taxon), then retry.';
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { message: string; data: unknown } }).error;
    expect(error.message).toContain("Unknown interval 'Foobarian'");
    expect(error.data).toMatchObject({ reason: 'pbdb_invalid_parameter', recovery: { hint } });
    const text = renderText(result.content as { type: string; text?: string }[]);
    expect(text).toContain("Unknown interval 'Foobarian'");
    expect(text).toContain(`Recovery: ${hint}`);
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

  it('keeps line breaks in PBDB text on their content[] line and verbatim in structuredContent (#33)', async () => {
    const row: Occurrence = {
      occurrence_no: 1,
      collection_no: 2,
      accepted_no: 3,
      accepted_name: 'Tyrannosaurus rex\n### Forged',
      accepted_rank: 'species\r\n- forged',
      identified_name: 'Tyrannosaurus\r**forged:** x',
      identified_rank: 'genus\n\n> forged',
      early_interval: 'Late\nMaastrichtian',
      late_interval: 'Danian\r\n',
      max_ma: 72.2,
      min_ma: 66,
      lng: -113,
      lat: 51.9,
      paleolng: -68.2,
      paleolat: 64.1,
      paleomodel: 'gplates\n# forged',
      geoplate: '101\n| forged',
      formation: 'Hell Creek\n### Forged',
      geological_group: 'Montana\r\nGroup',
      member: 'Upper\n\nmember',
      county: 'Garfield\nCounty',
      state: 'Montana\r',
      cc: 'US\n',
      classification: { phylum: 'Chordata\n### Forged', genus: 'Tyrannosaurus\r\n' },
      reference_no: 4,
    };
    stubRows([row], { recordsFound: 1 });
    const result = await runToolContract(searchOccurrencesTool, { base_name: 'Tyrannosaurus' });

    expect(
      (result.structuredContent as { occurrences: Occurrence[] }).occurrences[0],
    ).toStrictEqual(row);
    const md = renderText(result.content as { type: string; text?: string }[]);
    expect(md).not.toContain('\r');
    expect(md).not.toMatch(/^(#+|-|>|\|) ?[Ff]orged/m);
    expect(md).toContain(
      [
        '### Tyrannosaurus rex ### Forged (species - forged)',
        '**occurrence_no:** 1 | **collection_no:** 2 | **taxon_no:** 3',
        '**identified as:** Tyrannosaurus **forged:** x (genus > forged)',
        '**age:** Late Maastrichtian – Danian (72.2–66 Ma)',
        '**modern coords:** 51.9, -113',
        '**paleo coords:** 64.1, -68.2 [gplates # forged] · plate 101 | forged',
        '**strata:** formation Hell Creek ### Forged, group Montana Group, member Upper member',
        '**locality:** Garfield County, Montana, US',
        '**classification:** phylum: Chordata ### Forged › genus: Tyrannosaurus',
        '**reference_no:** 4',
      ].join('\n'),
    );
  });

  it('keeps a line break in a PBDB warning inside the notice blockquote (#33)', async () => {
    const warning = "there are no records with lithology 'x'\n### Forged";
    stubRows([tRex], { recordsFound: 1, warnings: [warning] });
    const result = await runToolContract(searchOccurrencesTool, { base_name: 'Dinosauria' });

    const md = renderText(result.content as { type: string; text?: string }[]);
    expect(md).not.toMatch(/^### Forged/m);
    expect(md).toContain(
      "> PBDB could not use part of this query: there are no records with lithology 'x' ### Forged. That filter did not constrain",
    );
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
    const acquire = vi.fn().mockResolvedValue(instance);
    getCanvas.mockReturnValue({ acquire });

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
    // Nor is a canvas minted: an inline page holds no tenant canvas slot (#32).
    expect(acquire).not.toHaveBeenCalled();
    // content[]-only clients must not be pointed at the canvas either.
    const text = renderText(searchOccurrencesTool.format?.(result));
    expect(text).toContain('(spilled: no)');
    expect(text).not.toContain('canvasAbc01');
    expect(text).not.toContain('canvas');
  });

  it('spills a large result to the canvas and reports table_name + staged row_count', async () => {
    stubRows(paddedRows(400));
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
    stubRows(paddedRows(500), { recordsFound: 4170 });
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
      return { rows: capped, meta: { recordsFound: 4170 } };
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
    stubRows(paddedRows(400));
    const instance = makeFakeInstance('a-VBpZv9G');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.table_name).toBe('occurrences_a_VBpZv9G');
    expect(result.table_name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('reuses an explicit canvas_id passed by the caller when the page spills', async () => {
    stubRows(paddedRows(400));
    const instance = makeFakeInstance('reusedId03', { isNew: false });
    const acquire = vi.fn().mockResolvedValue(instance);
    getCanvas.mockReturnValue({ acquire });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 500,
      canvas_id: 'reusedId03',
    });
    const result = await searchOccurrencesTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('reusedId03', ctx);
    // The occurrence table is replaced under the same name, not appended to.
    expect(instance.registerTable).toHaveBeenCalledOnce();
    expect(instance.registerTable.mock.calls[0]?.[0]).toBe('occurrences_reusedId03');
    expect(result).toMatchObject({ spilled: true, canvas_id: 'reusedId03', row_count: 400 });
  });

  it('starts a fresh canvas when canvas_id arrives blank and the page spills (#22)', async () => {
    stubRows(paddedRows(400));
    const acquire = vi.fn().mockResolvedValue(makeFakeInstance('freshId004'));
    getCanvas.mockReturnValue({ acquire });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({
      base_name: 'Tyrannosaurus',
      limit: 500,
      canvas_id: '',
    });
    await searchOccurrencesTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith(undefined, ctx);
  });

  describe('canvas slots (#32)', () => {
    it('leaves a caller-supplied canvas_id untouched when the page fits inline', async () => {
      stubRows([tRex]);
      const acquire = vi.fn();
      getCanvas.mockReturnValue({ acquire, drop: vi.fn() });

      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Tyrannosaurus',
        canvas_id: 'staleId001',
      });

      expect(result.isError).toBeFalsy();
      expect(acquire).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ spilled: false, row_count: 1 });
      expect(result.structuredContent).not.toHaveProperty('canvas_id');
    });

    it('mints no canvas for a zero-match page', async () => {
      stubRows([], { recordsFound: 0 });
      const acquire = vi.fn();
      getCanvas.mockReturnValue({ acquire, drop: vi.fn() });

      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Tyrannosaurus',
        interval: 'Cambrian',
      });

      expect(result.isError).toBeFalsy();
      expect(acquire).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ row_count: 0, spilled: false });
    });

    it('mints no canvas when the upstream request fails', async () => {
      searchOccurrences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB is unavailable (HTTP 503).'),
      );
      const acquire = vi.fn();
      getCanvas.mockReturnValue({ acquire, drop: vi.fn() });

      const result = await runToolContract(searchOccurrencesTool, { base_name: 'Tyrannosaurus' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
      expect(acquire).not.toHaveBeenCalled();
    });

    it('drops a freshly minted canvas when staging fails, and rethrows', async () => {
      stubRows(paddedRows(400));
      const instance = makeFakeInstance('mintFail01');
      instance.registerTable.mockRejectedValue(new Error('appender failed'));
      const drop = vi.fn().mockResolvedValue(true);
      getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance), drop });

      const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
      const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
      await expect(searchOccurrencesTool.handler(input, ctx)).rejects.toThrow('appender failed');
      expect(drop).toHaveBeenCalledWith('mintFail01', ctx);
    });

    it('keeps a caller-supplied canvas when staging fails, dropping only the partial table', async () => {
      stubRows(paddedRows(400));
      const instance = makeFakeInstance('reuseFail1', { isNew: false });
      instance.registerTable.mockRejectedValue(new Error('appender failed'));
      const drop = vi.fn();
      getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance), drop });

      const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
      const input = searchOccurrencesTool.input.parse({
        base_name: 'Dinosauria',
        limit: 500,
        canvas_id: 'reuseFail1',
      });
      await expect(searchOccurrencesTool.handler(input, ctx)).rejects.toThrow('appender failed');
      expect(drop).not.toHaveBeenCalled();
      expect(instance.drop).toHaveBeenCalledWith('occurrences_reuseFail1');
    });
  });

  describe('spill notice and descriptions (#26)', () => {
    const describeThenQuery =
      'call paleobiology_dataframe_describe for the table and column names, then paleobiology_dataframe_query';

    it('names describe, then query, on both surfaces of a spilled result', async () => {
      stubRows(paddedRows(400), { recordsFound: 400 });
      getCanvas.mockReturnValue({
        acquire: vi.fn().mockResolvedValue(makeFakeInstance('canvasDsc1')),
      });

      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Dinosauria',
        limit: 500,
      });

      const structured = result.structuredContent as { notice: string; occurrences: unknown[] };
      expect(structured.notice).toContain(
        `Staged 400 matching occurrences on canvas canvasDsc1 as table "occurrences_canvasDsc1" — ${structured.occurrences.length} rendered inline; ${describeThenQuery} to analyze the full staged set with SQL (e.g. count by interval, group by formation).`,
      );
      expect(renderText(result.content as { type: string; text?: string }[])).toContain(
        describeThenQuery,
      );
    });

    it('names no dataframe tool on a result that fit inline (#16)', async () => {
      stubRows([tRex, { ...tRex, occurrence_no: 2 }], { recordsFound: 40 });
      getCanvas.mockReturnValue({ acquire: vi.fn() });

      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Tyrannosaurus',
        limit: 2,
      });

      expect(result.structuredContent).not.toHaveProperty('canvas_id');
      expect(result.structuredContent).not.toHaveProperty('table_name');
      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain('Advance offset to 2 for the next page.');
      expect(notice).not.toContain('paleobiology_dataframe');
    });

    it('names both dataframe tools in the canvas_id and table_name descriptions, describe first for canvas_id', () => {
      const { canvas_id, table_name } = searchOccurrencesTool.output.shape;
      for (const field of [canvas_id, table_name]) {
        expect(field.description).toContain('paleobiology_dataframe_describe');
        expect(field.description).toContain('paleobiology_dataframe_query');
      }
      const text = String(canvas_id.description);
      expect(text.indexOf('paleobiology_dataframe_describe')).toBeLessThan(
        text.indexOf('paleobiology_dataframe_query'),
      );
    });

    it('names the dataframe tools only inside the sentence conditioned on DataCanvas', () => {
      const sentences = searchOccurrencesTool.description.split(/(?<=\.)\s+/);
      const naming = sentences.filter((s) => s.includes('paleobiology_dataframe_'));
      expect(naming).toEqual([
        'When this deployment has DataCanvas enabled, a set that outgrows the inline preview stages on a canvas (canvas_id + table_name, returned only then): list its columns with paleobiology_dataframe_describe, then run SQL with paleobiology_dataframe_query (count by interval, group by formation/country, map by region).',
      ]);
    });
  });
});

describe('paleobiology_search_occurrences inline response budget (#23)', () => {
  const BUDGET = 100_000;

  beforeEach(() => {
    searchOccurrences.mockReset();
    getCanvas.mockReset();
    getCanvas.mockReturnValue(undefined);
  });

  it('pins a five-row page byte for byte (regression)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...tRex, occurrence_no: 139292 + i }));
    stubRows(rows, { recordsFound: 22 });

    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Tyrannosaurus',
      limit: 5,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.occurrences).toEqual(rows);
    expect({ ...structured, occurrences: undefined }).toEqual({
      occurrences: undefined,
      spilled: false,
      row_count: 5,
      totalCount: 22,
      notice:
        'Showing occurrences 1–5 of 22. Advance offset to 5 for the next page. Or raise limit (max 500) to pull more per page.',
      attribution: 'Data from the Paleobiology Database (paleobiodb.org), licensed CC BY 4.0.',
    });
    expect(result.content).toMatchInlineSnapshot(`
      [
        {
          "text": "**5 occurrence(s)** (spilled: no).

      ### Tyrannosaurus rex (species)
      **occurrence_no:** 139292 | **collection_no:** 11917 | **taxon_no:** 54833
      **age:** Late Maastrichtian (72.2–66 Ma)
      **modern coords:** 51.9064, -113.0289
      **paleo coords:** 64.06, -68.22 [gplates]
      **strata:** formation Scollard
      **locality:** CA
      **reference_no:** 4218

      ### Tyrannosaurus rex (species)
      **occurrence_no:** 139293 | **collection_no:** 11917 | **taxon_no:** 54833
      **age:** Late Maastrichtian (72.2–66 Ma)
      **modern coords:** 51.9064, -113.0289
      **paleo coords:** 64.06, -68.22 [gplates]
      **strata:** formation Scollard
      **locality:** CA
      **reference_no:** 4218

      ### Tyrannosaurus rex (species)
      **occurrence_no:** 139294 | **collection_no:** 11917 | **taxon_no:** 54833
      **age:** Late Maastrichtian (72.2–66 Ma)
      **modern coords:** 51.9064, -113.0289
      **paleo coords:** 64.06, -68.22 [gplates]
      **strata:** formation Scollard
      **locality:** CA
      **reference_no:** 4218

      ### Tyrannosaurus rex (species)
      **occurrence_no:** 139295 | **collection_no:** 11917 | **taxon_no:** 54833
      **age:** Late Maastrichtian (72.2–66 Ma)
      **modern coords:** 51.9064, -113.0289
      **paleo coords:** 64.06, -68.22 [gplates]
      **strata:** formation Scollard
      **locality:** CA
      **reference_no:** 4218

      ### Tyrannosaurus rex (species)
      **occurrence_no:** 139296 | **collection_no:** 11917 | **taxon_no:** 54833
      **age:** Late Maastrichtian (72.2–66 Ma)
      **modern coords:** 51.9064, -113.0289
      **paleo coords:** 64.06, -68.22 [gplates]
      **strata:** formation Scollard
      **locality:** CA
      **reference_no:** 4218",
          "type": "text",
        },
        {
          "text": "

      **Source:** Data from the Paleobiology Database (paleobiodb.org), licensed CC BY 4.0.
      **22 total**
      > Showing occurrences 1–5 of 22. Advance offset to 5 for the next page. Or raise limit (max 500) to pull more per page.",
          "type": "text",
        },
      ]
    `);
  });

  it('cuts a full canvas-off page to the budget, keeping totalCount and naming the next offset', async () => {
    stubRows(realisticRows(500), { recordsFound: 37883 });

    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
    });

    const bytes = surfaceBytes(result);
    expect(bytes.structured).toBeLessThanOrEqual(BUDGET);
    expect(bytes.text).toBeLessThanOrEqual(BUDGET);
    const structured = result.structuredContent as {
      occurrences: Occurrence[];
      row_count: number;
      totalCount: number;
      notice: string;
    };
    const shown = structured.occurrences.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(500);
    expect(structured.row_count).toBe(shown);
    expect(structured.totalCount).toBe(37883);
    expect(structured.notice).toContain(`Showing occurrences 1–${shown} of 37883.`);
    expect(structured.notice).toContain(`Advance offset to ${shown} for the next page.`);
    expect(structured.notice).toContain(
      `This page was cut to ${shown} of the 500 pulled to fit the inline response size.`,
    );
    expect(structured.notice).not.toContain('raise limit');
    // Without a canvas the cut page cannot stage; the notice says so as behavior.
    expect(structured.notice).toContain(
      'This deployment has no DataCanvas, so a page too large to show inline cannot be staged for SQL; page through it with offset.',
    );
    expect(structured.notice).not.toContain('CANVAS_PROVIDER_TYPE');
    // Rows are cut whole and both surfaces carry the same rows.
    const text = renderText(result.content as { type: string; text?: string }[]);
    expect(text.split('\n### ').length - 1).toBe(shown);
    expect(text).toContain(
      `**occurrence_no:** ${structured.occurrences[shown - 1]?.occurrence_no}`,
    );
    expect(text).not.toContain(`**occurrence_no:** ${shown + 1} `);
  });

  it('serves a limit above 500 at the 500 cap and names it', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return { rows: bareRows(filter.limit), meta: { recordsFound: 37883 } };
    });

    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 600,
    });

    expect(result.isError).toBeFalsy();
    expect(captured?.limit).toBe(500);
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toContain('Showing occurrences 1–500 of 37883.');
    expect(notice).toContain('Advance offset to 500 for the next page.');
    expect(notice).toContain(
      'limit 600 is above the per-call cap of 500, so this page drew from at most 500 occurrences.',
    );
    expect(notice).not.toContain('raise limit');
  });

  it('rejects a limit above the 10,000 ceiling at the schema', async () => {
    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 10_001,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, message: expect.stringMatching(/\blimit\b/) },
    });
    expect(searchOccurrences).not.toHaveBeenCalled();
    expect(searchOccurrencesTool.input.parse({ base_name: 'X', limit: 10_000 }).limit).toBe(10_000);
  });

  it('walks a budget-cut match set by the named offsets with no gaps or repeats', async () => {
    const all = realisticRows(1200);
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => ({
      rows: all.slice(filter.offset, filter.offset + filter.limit),
      meta: { recordsFound: all.length },
    }));

    const seen: number[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Dinosauria',
        limit: 500,
        offset,
      });
      const bytes = surfaceBytes(result);
      expect(Math.max(bytes.structured, bytes.text)).toBeLessThanOrEqual(BUDGET);
      const structured = result.structuredContent as { occurrences: Occurrence[]; notice?: string };
      seen.push(...structured.occurrences.map((o) => o.occurrence_no));
      pages += 1;
      const next = /Advance offset to (\d+)/.exec(structured.notice ?? '')?.[1];
      if (!next) break;
      expect(Number(next)).toBe(offset + structured.occurrences.length);
      offset = Number(next);
    }
    expect(pages).toBeGreaterThan(3);
    expect(seen).toEqual(all.map((o) => o.occurrence_no));
  });

  it('spills on the same budget and keeps both surfaces inside it (canvas on)', async () => {
    stubRows(realisticRows(500), { recordsFound: 37883 });
    getCanvas.mockReturnValue({
      acquire: vi.fn().mockResolvedValue(makeFakeInstance('canvasBgt1')),
    });

    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 500,
      offset: 1000,
    });

    const bytes = surfaceBytes(result);
    expect(bytes.structured).toBeLessThanOrEqual(BUDGET);
    expect(bytes.text).toBeLessThanOrEqual(BUDGET);
    const structured = result.structuredContent as {
      occurrences: Occurrence[];
      spilled: boolean;
      row_count: number;
      notice: string;
    };
    expect(structured.spilled).toBe(true);
    expect(structured.row_count).toBe(500);
    expect(structured.occurrences.length).toBeLessThan(500);
    // The next offset counts staged rows, not the inline preview.
    expect(structured.notice).toContain('Showing occurrences 1001–1500 of 37883.');
    expect(structured.notice).toContain('Advance offset to 1500 for the next page.');
  });

  it('advances by the rows delivered on a canvas-on page that fits inline', async () => {
    stubRows(bareRows(50), { recordsFound: 4170 });
    const acquire = vi.fn();
    getCanvas.mockReturnValue({ acquire });

    const result = await runToolContract(searchOccurrencesTool, {
      base_name: 'Dinosauria',
      limit: 50,
      offset: 100,
    });

    const structured = result.structuredContent as { spilled: boolean; notice: string };
    expect(structured.spilled).toBe(false);
    expect(structured.notice).toContain('Showing occurrences 101–150 of 4170.');
    expect(structured.notice).toContain('Advance offset to 150 for the next page.');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('walks a spilling match set by the named offsets, each page staged whole', async () => {
    const all = realisticRows(1200);
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => ({
      rows: all.slice(filter.offset, filter.offset + filter.limit),
      meta: { recordsFound: all.length },
    }));
    const instance = makeFakeInstance('canvasWlk1');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    let offset = 0;
    for (;;) {
      const result = await runToolContract(searchOccurrencesTool, {
        base_name: 'Dinosauria',
        limit: 500,
        offset,
      });
      const structured = result.structuredContent as { spilled: boolean; notice?: string };
      // Every page of these rows, the 200-row last one included, outgrows the budget.
      expect(structured.spilled).toBe(true);
      const next = /Advance offset to (\d+)/.exec(structured.notice ?? '')?.[1];
      if (!next) break;
      offset = Number(next);
    }
    const staged = instance.registerTable.mock.calls.flatMap(([, rows]) =>
      rows.map((row) => row.occurrence_no),
    );
    expect(staged).toEqual(all.map((o) => o.occurrence_no));
  });
});

/** Rows padded so that 400 of them outgrow the inline budget and spill (~620 bytes of JSON each). */
function paddedRows(count: number): Occurrence[] {
  return Array.from({ length: count }, (_, i) => ({
    ...tRex,
    occurrence_no: i + 1,
    formation: 'X'.repeat(300),
  }));
}

/** Minimal rows: hundreds fit the inline budget, so the page limit is what binds. */
function bareRows(count: number): Occurrence[] {
  return Array.from({ length: count }, (_, i) => ({ occurrence_no: i + 1 }));
}

/** Rows at the size PBDB serves for a dinosaur search (~600 bytes of JSON each). */
function realisticRows(count: number): Occurrence[] {
  return Array.from({ length: count }, (_, i) => ({
    ...tRex,
    occurrence_no: i + 1,
    identified_name: 'Tyrannosaurus rex',
    identified_rank: 'species',
    geological_group: 'Edmonton',
    state: 'Alberta',
    county: 'Red Deer County',
    classification: {
      phylum: 'Chordata',
      class: 'Reptilia',
      order: 'Saurischia',
      family: 'Tyrannosauridae',
      genus: 'Tyrannosaurus',
    },
  }));
}

/**
 * A fake CanvasInstance covering the methods the handler touches. registerTable
 * reports every row it is handed as rowCount, as a real provider does after
 * ingesting the page. `isNew` false stands for a canvas the caller already held.
 */
function makeFakeInstance(canvasId: string, { isNew = true }: { isNew?: boolean } = {}) {
  return {
    canvasId,
    tenantId: 'default',
    isNew,
    drop: vi.fn().mockResolvedValue(true),
    registerTable: vi.fn(async (name: string, rows: Occurrence[]) => ({
      tableName: name,
      rowCount: rows.length,
      columns: Object.keys(rows[0] ?? {}),
    })),
  };
}

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
