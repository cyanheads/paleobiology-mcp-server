/**
 * @fileoverview Record normalization through the real service and public contracts.
 * @module tests/services/record-contracts
 */
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { occurrenceResource } from '@/mcp-server/resources/definitions/occurrence.resource.js';
import { referenceResource } from '@/mcp-server/resources/definitions/reference.resource.js';
import { taxonResource } from '@/mcp-server/resources/definitions/taxon.resource.js';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import {
  initPbdbService,
  normalizeOccurrence,
  normalizeReference,
  normalizeTaxon,
} from '@/services/pbdb/pbdb-service.js';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  initPbdbService(parseConfig());
});
afterEach(() => vi.unstubAllGlobals());
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((b) => b.text ?? '').join('\n');

describe('record characterization', () => {
  it('keeps genuine names, sparse ranges and plain citation text', () => {
    expect(
      normalizeOccurrence({ occurrence_no: '1', family: 'Tyrannosauridae' }).classification,
    ).toEqual({ family: 'Tyrannosauridae' });
    expect(
      normalizeTaxon({ taxon_no: '1', taxon_rank: 'genus', accepted_name: 'Example' }).range,
    ).toEqual({ first_appearance: {}, last_appearance: {} });
    expect(normalizeReference({ reference_no: '1', formatted: 'A < B & C\r\n' }).citation).toBe(
      'A < B & C\r\n',
    );
  });
});

describe('record regressions', () => {
  it.each([
    [5, 'genus'],
    ['5', 'genus'],
    ['genus', 'genus'],
    ['unranked clade', 'unranked clade'],
    ['new upstream rank', 'new upstream rank'],
  ])('decodes compact own rank %s without closing named ranks', async (rank, expected) => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        records: [{ oid: 'txn:1', nam: 'Matched', rnk: rank }],
      }),
    );
    const result = await runToolContract(getTaxonTool, { taxon_no: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ rank: expected, accepted_rank: expected });
    expect(textOf(result)).toContain(String(expected));
  });

  it.each(['phylum', 'class', 'order', 'family', 'genus'] as const)(
    'omits the %s unspecified marker',
    (rank) => {
      expect(
        normalizeOccurrence({ occurrence_no: '1', [rank]: `NO_${rank.toUpperCase()}_SPECIFIED` }),
      ).not.toHaveProperty('classification');
      expect(
        normalizeTaxon({ taxon_no: '1', [rank]: `NO_${rank.toUpperCase()}_SPECIFIED` })
          .classification,
      ).toEqual({});
      expect(
        normalizeOccurrence({ occurrence_no: '1', [rank]: 'Genuine name' }).classification,
      ).toEqual({ [rank]: 'Genuine name' });
    },
  );

  it('removes unspecified classification in the occurrence resource', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        records: [
          { occurrence_no: '130294', family: 'NO_FAMILY_SPECIFIED', genus: 'Protarchaeopteryx' },
        ],
      }),
    );
    expect(
      await occurrenceResource.handler(
        { occurrence_no: '130294' },
        createMockContext({ errors: occurrenceResource.errors }),
      ),
    ).toMatchObject({ classification: { genus: 'Protarchaeopteryx' } });
  });

  it('fails incomplete redirected identity rather than fabricating an accepted name', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ records: [{ oid: 'txn:1', nam: 'Matched', rnk: 'genus', acc: 'txn:2' }] }),
    );
    const result = await runToolContract(getTaxonTool, { taxon_no: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32000 } });
    expect(textOf(result)).toContain('accepted identity');
  });

  it('keeps real synonym statuses and their accepted rank', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        records: [
          {
            oid: 'txn:67659',
            nam: 'Shanshanosaurinae',
            rnk: 'subfamily',
            acc: 'txn:65352',
            acn: 'Tyrannosaurinae',
            acr: 8,
            tdf: 'subjective synonym of',
          },
        ],
      }),
    );
    const result = await runToolContract(getTaxonTool, { taxon_no: 67659 });
    expect(result.structuredContent).toMatchObject({
      taxon_no: 67659,
      name: 'Shanshanosaurinae',
      accepted_no: 65352,
      accepted_name: 'Tyrannosaurinae',
      accepted_rank: 'subfamily',
      status: 'subjective synonym of',
    });
    expect(textOf(result)).toContain('subjective synonym of');
  });

  it('separates matched and accepted identities through both taxon surfaces and children', async () => {
    const own = {
      oid: 'txn:38614',
      rnk: 'genus',
      nam: 'Aublysodon',
      tdf: 'nomen dubium',
      acc: 'txn:38606',
      acr: 9,
      acn: 'Tyrannosauridae',
      noc: 24,
      par: 'txn:38606',
      prl: 'Tyrannosauridae',
      ext: '0',
      fea: 93.9,
      fla: 89.8,
      tei: 'Turonian',
    };
    fetchMock.mockImplementation(async (input) => {
      const u = new URL(input instanceof Request ? input.url : input);
      return Response.json({
        records: u.pathname.endsWith('/single.json')
          ? [{ ...own, rnk: u.searchParams.has('name') ? 5 : 'genus' }]
          : [
              {
                oid: 'txn:57588',
                rnk: 'species',
                nam: 'Ornithomimus grandis',
                tdf: 'nomen dubium, species not entered',
                acc: 'txn:38606',
                acr: 9,
                acn: 'Tyrannosauridae',
                noc: 1,
              },
            ],
      });
    });
    for (const input of [
      { name: 'Aublysodon', show_children: true },
      { taxon_no: 38614, show_children: true },
    ]) {
      const result = await runToolContract(getTaxonTool, input);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        taxon_no: 38614,
        name: 'Aublysodon',
        rank: 'genus',
        accepted_no: 38606,
        accepted_name: 'Tyrannosauridae',
        accepted_rank: 'family',
        status: 'nomen dubium',
        occurrence_count: 24,
        children: [
          { taxon_no: 57588, rank: 'species', status: 'nomen dubium, species not entered' },
        ],
      });
      const text = textOf(result);
      for (const value of [
        'Aublysodon',
        '38614',
        '38606',
        'Tyrannosauridae',
        'family',
        'nomen dubium',
        'species',
      ])
        expect(text).toContain(value);
      expect(text).not.toContain('synonym of Tyrannosauridae');
    }
    const resource = await taxonResource.handler(
      { taxon_no: '38614' },
      createMockContext({ errors: taxonResource.errors }),
    );
    expect(resource).toMatchObject({
      name: 'Aublysodon',
      rank: 'genus',
      accepted_no: 38606,
      status: 'nomen dubium',
    });
    expect(
      fetchMock.mock.calls.every(
        ([input]) => new URL(String(input)).searchParams.get('vocab') === 'com',
      ),
    ).toBe(true);
  });

  it('uses own identity when compact accepted fields are omitted and pages children', async () => {
    fetchMock.mockImplementation(async (input) => {
      const u = new URL(input instanceof Request ? input.url : input);
      if (u.pathname.endsWith('/single.json'))
        return Response.json({
          records: [{ oid: 'txn:1', rnk: 'genus', nam: 'Parent', ext: '1' }],
        });
      const offset = Number(u.searchParams.get('offset'));
      return Response.json({
        records:
          offset === 0
            ? Array.from({ length: 201 }, (_, i) => ({
                oid: `txn:${i + 2}`,
                rnk: 'species',
                nam: `Child ${i}`,
              }))
            : offset === 200
              ? [{ oid: 'txn:202', rnk: 'species', nam: 'Last' }]
              : [],
      });
    });
    for (const [offset, length, truncated] of [
      [0, 200, true],
      [200, 1, false],
      [400, 0, false],
    ] as const) {
      const result = await runToolContract(getTaxonTool, {
        taxon_no: 1,
        show_children: true,
        children_offset: offset,
      });
      expect(result.structuredContent).toMatchObject({
        name: 'Parent',
        accepted_name: 'Parent',
        accepted_no: 1,
        accepted_rank: 'genus',
        children_offset: offset,
        children_truncated: truncated,
      });
      expect((result.structuredContent as { children: unknown[] }).children).toHaveLength(length);
      expect(textOf(result)).toContain(`children_offset ${offset}`);
    }
  });

  it.each([
    ['<i>Taxon</i> IV<sup>e</sup>', 'Taxon IVe'],
    ['A &amp; B &#38; C &#x26; D &eacute;', 'A & B & C & D é'],
    ['&lt;i&gt;text&lt;/i&gt;', '<i>text</i>'],
    ['&amp;lt;i&amp;gt;', '&lt;i&gt;'],
    ['A < B & Simon & Schuster\r\n', 'A < B & Simon & Schuster\r\n'],
  ])('normalizes reference HTML once: %s', (raw, plain) => {
    expect(
      normalizeReference({ reference_no: '1', formatted: raw, reftitle: raw, pubtitle: raw }),
    ).toMatchObject({ citation: plain, title: plain, publication: plain });
  });

  it('shares normalized reference text and escapes residual Markdown syntax', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        records: [
          {
            reference_no: '1',
            formatted: '<i>A</i> &amp; &lt;i&gt; &amp;lt;i&amp;gt;',
            reftitle: '<sup>B</sup>',
            pubtitle: 'A < B',
          },
        ],
      }),
    );
    const result = await runToolContract(getReferencesTool, { reference_nos: [1] });
    expect(result.structuredContent).toMatchObject({
      references: [{ citation: 'A & <i> &lt;i&gt;', title: 'B', publication: 'A < B' }],
    });
    expect(textOf(result)).toContain('A & \\<i> \\&lt;i\\&gt;');
    expect(
      await referenceResource.handler(
        { reference_no: '1' },
        createMockContext({ errors: referenceResource.errors }),
      ),
    ).toMatchObject({ citation: 'A & <i> &lt;i&gt;', title: 'B', publication: 'A < B' });
  });
});
