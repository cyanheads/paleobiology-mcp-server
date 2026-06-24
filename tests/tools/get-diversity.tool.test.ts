/**
 * @fileoverview Handler tests for paleobiology_get_diversity. Covers the happy
 * path (full bin set inline), the required-field-on-empty regression (a
 * zero-bin result must still return { bins: [] } that validates and carries an
 * actionable notice), the filter → service mapping, and format() parity for
 * both populated and empty results.
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
    expect(String(getEnrichment(ctx).notice)).toMatch(/No diversity bins for "Nothingium"/);
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
