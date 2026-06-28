/**
 * @fileoverview Handler tests for paleobiology_get_diversity. Covers the happy
 * path (full bin set inline), the oldest-first reordering of PBDB's native
 * newest-first bins (structuredContent + content[]), the required-field-on-empty
 * regression (a zero-bin result must still return { bins: [] } that validates and
 * carries an actionable notice), the filter → service mapping, and format()
 * parity for both populated and empty results.
 *
 * The PBDB layer is never hit: getPbdbService().getDiversity is a per-test fake.
 * @module tests/tools/get-diversity.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiversityBin, DiversityFilter } from '@/services/pbdb/types.js';

const getDiversity = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ getDiversity }) };
});

const { getDiversityTool } = await import('@/mcp-server/tools/definitions/get-diversity.tool.js');

const cretaceousBin: DiversityBin = {
  interval: 'Cretaceous',
  max_ma: 143.1,
  min_ma: 66,
  sampled_in_bin: 1328,
  implied: 44,
  originations: 1276,
  extinctions: 1328,
  range_through: 0,
  n_occurrences: 16198,
};

const jurassicBin: DiversityBin = {
  interval: 'Jurassic',
  max_ma: 201.4,
  min_ma: 143.1,
  sampled_in_bin: 220,
  implied: 30,
  originations: 180,
  extinctions: 160,
  range_through: 40,
  n_occurrences: 1200,
};

const triassicBin: DiversityBin = {
  interval: 'Triassic',
  max_ma: 251.902,
  min_ma: 201.4,
  sampled_in_bin: 60,
  implied: 5,
  originations: 55,
  extinctions: 40,
  range_through: 10,
  n_occurrences: 300,
};

describe('paleobiology_get_diversity', () => {
  beforeEach(() => {
    getDiversity.mockReset();
  });

  it('returns the full bin set inline and conforms to the output schema', async () => {
    getDiversity.mockResolvedValue([cretaceousBin]);
    const ctx = createMockContext();
    const input = getDiversityTool.input.parse({ base_name: 'Dinosauria' });
    const result = await getDiversityTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getDiversityTool.output));
    expect(result.bins).toHaveLength(1);
    expect(result.bins[0]).toMatchObject({ interval: 'Cretaceous', originations: 1276 });
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 1 });
  });

  it('reorders PBDB newest-first bins to oldest-first (Triassic → Jurassic → Cretaceous)', async () => {
    // PBDB returns the Mesozoic newest-first; the handler flips it to oldest-first
    // so structuredContent.bins matches the schema's documented order.
    getDiversity.mockResolvedValue([cretaceousBin, jurassicBin, triassicBin]);
    const ctx = createMockContext();
    const input = getDiversityTool.input.parse({ base_name: 'Dinosauria', interval: 'Mesozoic' });
    const result = await getDiversityTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getDiversityTool.output));
    expect(result.bins.map((b) => b.interval)).toEqual(['Triassic', 'Jurassic', 'Cretaceous']);
    // max_ma strictly descending — oldest interval (highest max_ma) first.
    expect(result.bins.map((b) => b.max_ma)).toEqual([251.902, 201.4, 143.1]);
    // format() renders the same oldest-first order in content[].
    const text = renderText(getDiversityTool.format?.(result));
    expect(text.indexOf('Triassic')).toBeLessThan(text.indexOf('Jurassic'));
    expect(text.indexOf('Jurassic')).toBeLessThan(text.indexOf('Cretaceous'));
  });

  it('applies count/resolution defaults and forwards span filters to the service', async () => {
    let captured: DiversityFilter | undefined;
    getDiversity.mockImplementation(async (filter: DiversityFilter) => {
      captured = filter;
      return [];
    });
    const ctx = createMockContext();
    const input = getDiversityTool.input.parse({
      base_name: 'Ammonoidea',
      max_ma: 251.9,
      min_ma: 66,
    });
    await getDiversityTool.handler(input, ctx);
    expect(captured).toEqual({
      baseName: 'Ammonoidea',
      count: 'genera', // default
      resolution: 'period', // default
      maxMa: 251.9,
      minMa: 66,
    });
  });

  it('returns { bins: [] } (still valid) with a guidance notice on an empty result', async () => {
    getDiversity.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getDiversityTool.input.parse({ base_name: 'Nothingium', interval: 'Holocene' });
    const result = await getDiversityTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getDiversityTool.output));
    expect(result.bins).toEqual([]);
    const enr = getEnrichment(ctx);
    expect(String(enr.notice)).toMatch(/No diversity bins for "Nothingium"/);
    // #3: notice + attribution are enrichment fields the framework renders into content[].
    expect(String(enr.attribution)).toMatch(/Paleobiology Database/);
  });

  it('format() renders a turnover table for populated bins', () => {
    const out = getDiversityTool.output.parse({ bins: [cretaceousBin] });
    const text = renderText(getDiversityTool.format?.(out));
    expect(text).toContain('Cretaceous');
    expect(text).toContain('143.1–66');
    expect(text).toContain('originations');
    expect(text).toContain('1276');
    expect(text).toMatch(/sampled diversity/i);
  });

  it('format() renders a clear empty message when there are no bins', () => {
    const out = getDiversityTool.output.parse({ bins: [] });
    const text = renderText(getDiversityTool.format?.(out));
    expect(text).toMatch(/No diversity bins/i);
  });
});

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
