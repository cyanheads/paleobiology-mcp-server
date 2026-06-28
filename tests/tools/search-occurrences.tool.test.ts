/**
 * @fileoverview Handler tests for paleobiology_search_occurrences — the flagship.
 * Covers the canvas-disabled inline path (including the required-field-on-empty
 * regression: a zero-result return must still carry spilled/row_count and
 * validate against the output schema), the limit-truncation notice, the
 * canvas-enabled non-spilled and spilled branches, the environment-enum →
 * filter mapping, format() parity (modern vs paleo coords), and sparse rows.
 *
 * Neither PBDB nor DuckDB is hit: getPbdbService() yields an async generator of
 * fake rows, and getCanvas() returns a fake DataCanvas whose acquired instance
 * stands in for the real spill target.
 * @module tests/tools/search-occurrences.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Occurrence, OccurrenceFilter } from '@/services/pbdb/types.js';

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

/** Make searchOccurrences yield these rows, capturing the filter it was called with. */
function stubRows(rows: Occurrence[]): void {
  searchOccurrences.mockImplementation((_filter: OccurrenceFilter) => rowGen(rows));
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

  it('discloses truncation when the result fills the requested limit', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...tRex, occurrence_no: i + 1 }));
    stubRows(rows);
    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 2 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.row_count).toBe(2);
    // The pull filled the cap (limit 2) — disclose it honestly, don't imply completeness.
    expect(String(getEnrichment(ctx).notice)).toMatch(
      /first 2 occurrences.*CANVAS_PROVIDER_TYPE=duckdb/s,
    );
    expect(String(getEnrichment(ctx).notice)).toMatch(/more may match/);
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

  it('accepts collection_no as a sole filter and maps it to the service (drilldown)', async () => {
    let captured: OccurrenceFilter | undefined;
    searchOccurrences.mockImplementation((filter: OccurrenceFilter) => {
      captured = filter;
      return rowGen([tRex]);
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
      return rowGen([]);
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

  it('returns canvas_id without spilling when the result fits inline', async () => {
    stubRows([tRex]);
    const instance = makeFakeInstance('canvasAbc01');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Tyrannosaurus' });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(searchOccurrencesTool.output));
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('canvasAbc01');
    expect(result.table_name).toBeUndefined();
    expect(result.row_count).toBe(1);
    // registerTable must NOT be called when the source fits the preview budget.
    expect(instance.registerTable).not.toHaveBeenCalled();
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
    // 400 rows < the 500-row cap, so this IS the complete matching set — no truncation claim.
    expect(String(getEnrichment(ctx).notice)).not.toMatch(/more may match/);
  });

  it('discloses that a spilled set is a capped page when the pull hits the cap', async () => {
    // Yield exactly `limit` rows so the staged count equals the per-call cap — the
    // canvas holds a truncated page, not every match, and the notice must say so
    // instead of implying the staged table is the full set (issue #6).
    const capped = Array.from({ length: 500 }, (_, i) => ({
      ...tRex,
      occurrence_no: i + 1,
      formation: 'X'.repeat(300),
    }));
    stubRows(capped);
    const instance = makeFakeInstance('canvasCap03');
    getCanvas.mockReturnValue({ acquire: vi.fn().mockResolvedValue(instance) });

    const ctx = createMockContext({ errors: searchOccurrencesTool.errors });
    const input = searchOccurrencesTool.input.parse({ base_name: 'Dinosauria', limit: 500 });
    const result = await searchOccurrencesTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.row_count).toBe(500);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toMatch(/per-call cap/);
    expect(notice).toMatch(/more may match/);
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
