/**
 * @fileoverview Contract tests for paleobiology_get_references. Drives the real
 * PbdbService (request building, envelope parsing, the authorlist normalizer)
 * through runToolContract against a fetch fake that answers PBDB's `refs/list`
 * the way the live endpoint does: matching records only, in PBDB's own author
 * order, misses silently omitted. Records come from a live capture
 * (tests/fixtures/pbdb-refs-list.json). Covers request-order output, misses as
 * results (`not_found` + notice), the per-call cap and `remaining_reference_nos`,
 * dedupe, schema rejections that never reach PBDB, sparse records, verbatim
 * upstream text in structuredContent vs CR/LF-flattened text in content[], and
 * the CC BY attribution trailer.
 * @module tests/tools/get-references.tool
 */

import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';
import { initPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { PbdbReferenceRecord } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';
import { serveRefsList } from '../helpers/pbdb-refs.js';

const CITATION_149 =
  'D. A. Bone, J. A. Todd, and S. Tracey. 1991. Fossils from the Bracklesham Group exposed in the M27 Motorway excavations, Southampton, Hampshire. Tertiary Research 12(3-4):131-137';

const fetchMock = vi.fn<typeof fetch>();

/** The URL of every request the service sent. */
function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map(
    ([input]) => new URL(input instanceof Request ? input.url : input),
  );
}

/** Answer `refs/list` from `records` (the live capture by default), like PBDB. */
const servePbdbRefs = (records?: PbdbReferenceRecord[]) => serveRefsList(fetchMock, records);

/** A minimal existing reference, for cap tests that need many distinct ids. */
function stubRef(no: number): PbdbReferenceRecord {
  return { reference_no: String(no), formatted: `Author ${no}. 2000. Title ${no}.` };
}

function text(result: { content: unknown[] }): string {
  return result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');
}

type Out = {
  references: Array<Record<string, unknown> & { reference_no: number }>;
  not_found: number[];
  remaining_reference_nos?: number[];
  notice?: string;
  attribution?: string;
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initPbdbService(parseConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paleobiology_get_references', () => {
  it('resolves a reference to its verbatim citation and structured fields in one refs/list request', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [149] });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as Out;
    expect(out.references).toHaveLength(1);
    expect(out.references[0]).toMatchObject({
      reference_no: 149,
      citation: CITATION_149,
      volume: '12',
      issue: '3-4',
      first_page: '131',
      last_page: '137',
    });
    expect(out.references[0]?.authors).toHaveLength(3);
    expect(out.not_found).toEqual([]);
    expect(out).not.toHaveProperty('remaining_reference_nos');
    expect(out).not.toHaveProperty('notice');

    const [url] = requestedUrls();
    expect(requestedUrls()).toHaveLength(1);
    expect(url?.searchParams.get('ref_id')).toBe('149');
    expect(url?.searchParams.get('show')).toBe('both,authorlist');
    expect(url?.searchParams.get('vocab')).toBe('pbdb');

    const md = text(result);
    expect(md).toContain(`> ${CITATION_149}`);
    expect(md).toContain('**authors:** D. A. Bone; J. A. Todd; S. Tracey');
  });

  it('returns references in request order, not PBDB author order', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [4218, 149, 19309] });
    const out = result.structuredContent as Out;
    expect(out.references.map((r) => r.reference_no)).toEqual([4218, 149, 19309]);
    const md = text(result);
    expect(md.indexOf('reference_no 4218')).toBeLessThan(md.indexOf('reference_no 149'));
    expect(md.indexOf('reference_no 149')).toBeLessThan(md.indexOf('reference_no 19309'));
  });

  it('reports a miss as a result — not_found plus a notice naming where ids come from', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [149, 999999999] });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as Out;
    expect(out.references.map((r) => r.reference_no)).toEqual([149]);
    expect(out.not_found).toEqual([999999999]);
    const notice =
      'PBDB has no reference for reference_no 999999999. Take reference_no values from paleobiology_search_occurrences or paleobiology_search_collections rows.';
    expect(out.notice).toBe(notice);
    expect(text(result)).toContain(notice);
    expect(text(result)).toContain('**not_found:** 999999999');
  });

  it('succeeds with an empty references list when every id misses', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [999999999] });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ references: [], not_found: [999999999] });
  });

  it('names every missed id in one notice', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, {
      reference_nos: [999999998, 149, 999999999],
    });
    const out = result.structuredContent as Out;
    expect(out.not_found).toEqual([999999998, 999999999]);
    expect(out.notice).toBe(
      'PBDB has no reference for reference_nos 999999998, 999999999. Take reference_no values from paleobiology_search_occurrences or paleobiology_search_collections rows.',
    );
  });

  it.each([
    ['an empty list', []],
    ['zero', [0]],
    ['a negative id', [-1]],
    ['a fractional id', [1.5]],
    ['501 ids', Array.from({ length: 501 }, (_, i) => i + 1)],
  ])('rejects %s at the schema without calling PBDB', async (_label, reference_nos) => {
    const result = await runToolContract(getReferencesTool, { reference_nos });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, message: expect.stringContaining(': reference_nos') },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the 500-id ceiling, resolving the first 25 and returning the other 475', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    servePbdbRefs(ids.map(stubRef));
    const result = await runToolContract(getReferencesTool, { reference_nos: ids });
    const out = result.structuredContent as Out;
    expect(out.references).toHaveLength(25);
    expect(out.remaining_reference_nos).toEqual(ids.slice(25));
  });

  it('dedupes, then resolves the first 25 distinct ids in one request and returns the rest in remaining_reference_nos', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);
    servePbdbRefs(ids.map(stubRef));
    // A repeat is resolved once, and repeats ahead of the cut must not consume cap slots.
    const result = await runToolContract(getReferencesTool, {
      reference_nos: [ids[0] as number, ...ids],
    });

    const out = result.structuredContent as Out;
    expect(out.references.map((r) => r.reference_no)).toEqual(ids.slice(0, 25));
    expect(out.remaining_reference_nos).toEqual(ids.slice(25));
    expect(out.not_found).toEqual([]);
    expect(requestedUrls()).toHaveLength(1);
    expect(requestedUrls()[0]?.searchParams.get('ref_id')).toBe(ids.slice(0, 25).join(','));

    const notice =
      'Looked up the first 25 of 30 distinct reference_nos. Call paleobiology_get_references again with remaining_reference_nos for the rest.';
    expect(out.notice).toBe(notice);
    expect(text(result)).toContain(notice);
    expect(text(result)).toContain(`**remaining_reference_nos:** ${ids.slice(25).join(', ')}`);
  });

  it('joins the miss and remainder notices when both apply', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => 2000 + i);
    servePbdbRefs(ids.slice(1).map(stubRef));
    const result = await runToolContract(getReferencesTool, { reference_nos: ids });
    const out = result.structuredContent as Out;
    expect(out.not_found).toEqual([2000]);
    expect(out.notice).toBe(
      'PBDB has no reference for reference_no 2000. Take reference_no values from paleobiology_search_occurrences or paleobiology_search_collections rows. ' +
        'Looked up the first 25 of 26 distinct reference_nos. Call paleobiology_get_references again with remaining_reference_nos for the rest.',
    );
  });

  it('keeps sparse records sparse on both surfaces', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [5923, 5227, 56724] });
    const [unpublished, noType, emptyAuthor] = (result.structuredContent as Out).references;
    expect(unpublished).not.toHaveProperty('title');
    expect(noType).not.toHaveProperty('publication_type');
    expect(emptyAuthor?.authors).toHaveLength(18);
    const md = text(result);
    const block5923 = md.slice(md.indexOf('reference_no 5923'), md.indexOf('reference_no 5227'));
    expect(block5923).not.toContain('**title:**');
    expect(block5923).not.toContain('undefined');
  });

  it('keeps CR/LF verbatim in structuredContent and flattens it to one line in content[]', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [4398] });
    const ref = (result.structuredContent as Out).references[0];
    expect(ref?.title).toBe('The crocodilian Bernissartia in the Wealden of the Isle of Wight\r\n');
    const md = text(result);
    expect(md).not.toContain('\r');
    expect(md).toContain(
      '**title:** The crocodilian Bernissartia in the Wealden of the Isle of Wight\n',
    );
    expect(md).toContain(
      '> E. Buffetaut and R. L. E. Ford. 1979. The crocodilian Bernissartia in the Wealden of the Isle of Wight . Palaeontology 22(4):905-912',
    );
  });

  it('relays a literal ampersand unescaped on both surfaces', async () => {
    servePbdbRefs();
    const result = await runToolContract(getReferencesTool, { reference_nos: [51520] });
    expect((result.structuredContent as Out).references[0]?.publisher).toBe('Simon & Schuster');
    const md = text(result);
    expect(md).toContain('**publisher:** Simon & Schuster');
    expect(md).toContain('New York: Simon & Schuster.');
    expect(md).not.toContain('&amp;');
  });

  it('renders every output field in content[] and credits PBDB on both surfaces', async () => {
    const full: PbdbReferenceRecord = {
      reference_no: '42',
      publication_type: 'book chapter',
      reftitle: 'Chapter Title',
      pubyr: '1999',
      author: [{ firstname: 'A. B.', lastname: 'Author' }, { lastname: 'Solo' }],
      editors: [{ firstname: 'E.', lastname: 'Editor' }],
      pubtitle: 'Volume Title',
      pubvol: '7',
      pubno: '2',
      firstpage: 'viii',
      lastpage: '32A',
      publisher: 'Press Name',
      language: 'English',
      doi: '10.1130/0016-7606(1994)106<1377:APATLC>2.3.CO;2',
      formatted: 'A. B. Author and Solo. 1999. Chapter Title.',
    };
    servePbdbRefs([full]);
    const result = await runToolContract(getReferencesTool, { reference_nos: [42, 43] });
    const md = text(result);
    for (const line of [
      '### reference_no 42',
      '> A. B. Author and Solo. 1999. Chapter Title.',
      '**publication_type:** book chapter',
      '**title:** Chapter Title',
      '**year:** 1999',
      '**authors:** A. B. Author; Solo',
      '**editors:** E. Editor',
      '**publication:** Volume Title',
      '**volume:** 7',
      '**issue:** 2',
      '**first_page:** viii',
      '**last_page:** 32A',
      '**publisher:** Press Name',
      '**language:** English',
      '**doi:** 10.1130/0016-7606(1994)106<1377:APATLC>2.3.CO;2',
      '**not_found:** 43',
      `**Source:** ${PBDB_ATTRIBUTION}`,
    ]) {
      expect(md).toContain(line);
    }
    expect((result.structuredContent as Out).attribution).toBe(PBDB_ATTRIBUTION);
  });
});
