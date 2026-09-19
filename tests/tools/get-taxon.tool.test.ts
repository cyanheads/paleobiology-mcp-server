/**
 * @fileoverview Handler tests for paleobiology_get_taxon. Covers the happy path,
 * both declared error contracts (missing_selector, taxon_not_found), the
 * upstream-4xx → clean-not-found reclassification (asserting NO statusCode /
 * requestId / responseBody leaks onto the agent-facing error), show_children,
 * sparse upstream payloads, the required-field fail-loud (a taxon missing
 * accepted_name or rank is rejected, not emitted), the CC BY attribution
 * enrichment, format() parity, and output-schema conformance.
 *
 * The PBDB HTTP layer is never hit: getPbdbService() is mocked to a per-test
 * fake while isNotFoundError() (the real reclassification predicate) is kept
 * live via importActual, so the not-found remap is genuinely exercised.
 * @module tests/tools/get-taxon.tool
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Taxon } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';

const getTaxon = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ getTaxon }) };
});

const { getTaxonTool } = await import('@/mcp-server/tools/definitions/get-taxon.tool.js');

/** A fully-populated normalized taxon — what the service returns on the happy path. */
function fullTaxon(): Taxon {
  return {
    taxon_no: 54833,
    accepted_name: 'Tyrannosaurus',
    rank: 'genus',
    parent_no: 92294,
    parent_name: 'Tyrannosaurini',
    classification: { class: 'Reptilia', family: 'Tyrannosauridae' },
    extant: false,
    occurrence_count: 86,
    range: {
      first_appearance: { max_ma: 83.6, min_ma: 72.2, interval: 'Campanian' },
      last_appearance: { max_ma: 72.2, min_ma: 66, interval: 'Maastrichtian' },
    },
  };
}

describe('paleobiology_get_taxon', () => {
  beforeEach(() => {
    getTaxon.mockReset();
  });

  it('resolves a taxon by name into the full output shape', async () => {
    getTaxon.mockResolvedValue(fullTaxon());
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Tyrannosaurus' });
    const result = await getTaxonTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getTaxonTool.output));
    expect(result).toMatchObject({
      taxon_no: 54833,
      accepted_name: 'Tyrannosaurus',
      rank: 'genus',
      extant: false,
      occurrence_count: 86,
      first_appearance: { interval: 'Campanian' },
      last_appearance: { interval: 'Maastrichtian' },
    });
    // The service received the name selector, not a taxon_no.
    expect(getTaxon).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tyrannosaurus', showChildren: false }),
      ctx,
    );
  });

  it('emits the CC BY attribution enrichment, like every other PBDB-backed tool', async () => {
    getTaxon.mockResolvedValue(fullTaxon());
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Tyrannosaurus' });
    await getTaxonTool.handler(input, ctx);

    expect(String(getEnrichment(ctx).attribution)).toMatch(/Paleobiology Database/);
    expect(String(getEnrichment(ctx).attribution)).toMatch(/CC BY 4\.0/);
    // The trailer label is what renders it as `**Source:**` for content[]-only clients.
    expect(getTaxonTool.enrichmentTrailer?.attribution?.label).toBe('Source');
  });

  it('forwards taxon_no and show_children to the service', async () => {
    const withChildren = fullTaxon();
    withChildren.children = [
      { taxon_no: 67659, name: 'Tarbosaurus', rank: 'genus', occurrence_count: 40 },
    ];
    withChildren.children_offset = 0;
    withChildren.children_truncated = false;
    getTaxon.mockResolvedValue(withChildren);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ taxon_no: 54833, show_children: true });
    const result = await getTaxonTool.handler(input, ctx);

    expect(getTaxon).toHaveBeenCalledWith(
      { taxonNo: 54833, showChildren: true, childrenOffset: 0 },
      ctx,
    );
    expect(result.children).toHaveLength(1);
    expect(result.children?.[0]).toMatchObject({ taxon_no: 67659, name: 'Tarbosaurus' });
  });

  it('discloses a truncated child list and names the next children_offset (#15)', async () => {
    // A taxon with more immediate children than one page holds: the page must not
    // read as the complete list on either output surface.
    const big = fullTaxon();
    big.accepted_name = 'Turritella';
    big.children = childPage(200, 0);
    big.children_offset = 0;
    big.children_truncated = true;
    getTaxon.mockResolvedValue(big);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ taxon_no: 10637, show_children: true });
    const result = await getTaxonTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getTaxonTool.output));
    expect(result.children).toHaveLength(200);
    expect(result.children_truncated).toBe(true);
    expect(result.children_offset).toBe(0);
    expect(String(getEnrichment(ctx).notice)).toBe(
      'Showing immediate children 1–200 of Turritella; more remain. ' +
        'Advance children_offset to 200 for the next page.',
    );
    // content[]-only clients see the same verdict, not just a bare list of 200.
    const text = renderText(getTaxonTool.format?.(result));
    expect(text).toContain(
      '**children page:** children_offset 0, through child 200 — children_truncated: yes, more remain. Re-call with children_offset 200.',
    );
  });

  it('reports a complete child list as complete (#15)', async () => {
    const small = fullTaxon();
    small.children = childPage(3, 0);
    small.children_offset = 0;
    small.children_truncated = false;
    getTaxon.mockResolvedValue(small);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ taxon_no: 54833, show_children: true });
    const result = await getTaxonTool.handler(input, ctx);

    expect(result.children_truncated).toBe(false);
    // No notice: nothing was hidden, so there is nothing to warn about.
    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = renderText(getTaxonTool.format?.(result));
    expect(text).toContain(
      '**children page:** children_offset 0, through child 3 — children_truncated: no, this page reaches the end of the child list.',
    );
  });

  it('threads children_offset to the service and reports the second page (#15)', async () => {
    const page2 = fullTaxon();
    page2.children = childPage(127, 200);
    page2.children_offset = 200;
    page2.children_truncated = false;
    getTaxon.mockResolvedValue(page2);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({
      taxon_no: 10637,
      show_children: true,
      children_offset: 200,
    });
    const result = await getTaxonTool.handler(input, ctx);

    expect(getTaxon).toHaveBeenCalledWith(
      { taxonNo: 10637, showChildren: true, childrenOffset: 200 },
      ctx,
    );
    expect(result.children_offset).toBe(200);
    expect(result.children?.[0]).toMatchObject({ taxon_no: 900_200 });
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(renderText(getTaxonTool.format?.(result))).toContain(
      'children_offset 200, through child 327',
    );
  });

  it('reports an empty child page past the end as a paging overshoot (#15)', async () => {
    const past = fullTaxon();
    past.children = [];
    past.children_offset = 1000;
    past.children_truncated = false;
    getTaxon.mockResolvedValue(past);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({
      taxon_no: 10637,
      show_children: true,
      children_offset: 1000,
    });
    const result = await getTaxonTool.handler(input, ctx);

    expect(result.children).toEqual([]);
    expect(String(getEnrichment(ctx).notice)).toBe(
      'No immediate children at children_offset 1000 — the child list of Tyrannosaurus ends before it. ' +
        'Lower children_offset (0 starts at the first child).',
    );
  });

  it('omits the children fields entirely when show_children was false', async () => {
    getTaxon.mockResolvedValue(fullTaxon());
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Tyrannosaurus' });
    const result = await getTaxonTool.handler(input, ctx);

    // No child lookup ran, so there is no page to describe — don't imply one.
    expect(result).not.toHaveProperty('children');
    expect(result).not.toHaveProperty('children_offset');
    expect(result).not.toHaveProperty('children_truncated');
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(renderText(getTaxonTool.format?.(result))).not.toContain('children page');
    // children_offset is not forwarded when no child lookup was requested.
    expect(getTaxon).toHaveBeenCalledWith(
      expect.not.objectContaining({ childrenOffset: expect.anything() }),
      ctx,
    );
  });

  it('throws missing_selector when neither name nor taxon_no is given', async () => {
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({});
    await expect(getTaxonTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_selector' },
    });
    // The service must never be called when the selector is missing.
    expect(getTaxon).not.toHaveBeenCalled();
  });

  it('remaps a service not-found to the taxon_not_found contract reason', async () => {
    getTaxon.mockRejectedValue(notFound('No PBDB taxon matched the name "Notataxon".'));
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Notataxon' });
    await expect(getTaxonTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'taxon_not_found' },
    });
  });

  it('declares taxon_not_found below error severity, missing_selector at the default', () => {
    // A name that resolves to nothing is an ordinary lookup answer, not an
    // incident — it stays out of the error stream operators alert on. The
    // caller-input guard keeps the default error level.
    const entries: readonly { reason: string; severity?: string }[] = getTaxonTool.errors ?? [];
    expect(entries.find((e) => e.reason === 'taxon_not_found')?.severity).toBe('info');
    expect(entries.find((e) => e.reason === 'missing_selector')?.severity).toBeUndefined();
  });

  it('emits a typed not-found that does NOT leak the raw upstream status/requestId', async () => {
    // Simulate what reaches the handler after the service reclassified a PBDB
    // HTTP 400 — the service throws a clean notFound carrying only its reason.
    // The handler remaps it; the resulting error must expose the contract reason
    // and recovery, never the upstream statusCode / responseBody / requestId.
    getTaxon.mockRejectedValue(notFound('PBDB found no match during getTaxon.'));
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Bogusname' });

    const err = await expectMcpError(() => getTaxonTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('taxon_not_found');
    // Hardening regression: none of the raw HTTP plumbing fields may surface.
    expect(err.data).not.toHaveProperty('statusCode');
    expect(err.data).not.toHaveProperty('statusText');
    expect(err.data).not.toHaveProperty('responseBody');
    expect(err.data).not.toHaveProperty('requestId');
    // A recovery hint should still reach the wire for the agent's next move.
    expect(JSON.stringify(err.data)).toMatch(/spelling|higher rank|taxon_no/i);
  });

  it('rethrows a non-not-found service error unchanged (no spurious remap)', async () => {
    const upstream = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB is down.');
    getTaxon.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Tyrannosaurus' });
    await expect(getTaxonTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('tolerates a sparse extant taxon — empty appearance windows, no fabricated counts', async () => {
    const sparse: Taxon = {
      taxon_no: 36651,
      accepted_name: 'Homo',
      rank: 'genus',
      classification: {},
      extant: true,
      range: { first_appearance: {}, last_appearance: {} },
    };
    getTaxon.mockResolvedValue(sparse);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ name: 'Homo' });
    const result = await getTaxonTool.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(getTaxonTool.output));
    expect(result.extant).toBe(true);
    expect(result).not.toHaveProperty('occurrence_count');
    expect(result.first_appearance).toEqual({});
    // format() must render the unknown windows honestly, not invent ages.
    const text = renderText(getTaxonTool.format?.(result));
    expect(text).toContain('age unknown');
    expect(text).toContain('extant:** yes');
  });

  it('fails loud when PBDB returns a taxon without an accepted name or rank', async () => {
    // accepted_name and rank are required outputs — a record missing either is
    // unusable, so the handler throws rather than emit an incomplete taxon.
    const noRank: Taxon = {
      taxon_no: 54833,
      accepted_name: 'Tyrannosaurus',
      classification: {},
      extant: false,
      range: { first_appearance: {}, last_appearance: {} },
    };
    getTaxon.mockResolvedValue(noRank);
    const ctx = createMockContext({ errors: getTaxonTool.errors });
    const input = getTaxonTool.input.parse({ taxon_no: 54833 });
    await expect(getTaxonTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('format() renders ids, classification, and FAD/LAD windows', () => {
    const out = getTaxonTool.output.parse({
      taxon_no: 54833,
      accepted_name: 'Tyrannosaurus',
      rank: 'genus',
      classification: { class: 'Reptilia', family: 'Tyrannosauridae' },
      extant: false,
      occurrence_count: 86,
      first_appearance: { max_ma: 83.6, min_ma: 72.2, interval: 'Campanian' },
      last_appearance: { max_ma: 72.2, min_ma: 66, interval: 'Maastrichtian' },
    });
    const text = renderText(getTaxonTool.format?.(out));
    expect(text).toContain('taxon_no:** 54833');
    expect(text).toContain('Tyrannosaurus');
    expect(text).toContain('Tyrannosauridae');
    expect(text).toContain('Campanian');
    expect(text).toContain('83.6–72.2 Ma');
    expect(text).toContain('extant:** no (extinct)');
  });
});

/** A page of `count` child stubs numbered from `offset`, as the service would return them. */
function childPage(count: number, offset: number): NonNullable<Taxon['children']> {
  return Array.from({ length: count }, (_, i) => ({
    taxon_no: 900_000 + offset + i,
    name: `Child ${offset + i}`,
    rank: 'species',
  }));
}

/** Join a format() block list into a single string for substring assertions. */
function renderText(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}
