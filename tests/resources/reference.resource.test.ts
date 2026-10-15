/**
 * @fileoverview Tests for the paleobiology://reference/{reference_no} resource.
 * Drives the real PbdbService against a `refs/list` fetch fake (live capture in
 * tests/fixtures/pbdb-refs-list.json): the payload is the same record
 * paleobiology_get_references returns plus the CC BY attribution, a miss fails
 * `reference_not_found` with its declared recovery, and the param regex rejects
 * non-integer ids before any request.
 * @module tests/resources/reference.resource
 */

import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { referenceResource } from '@/mcp-server/resources/definitions/reference.resource.js';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';
import { initPbdbService } from '@/services/pbdb/pbdb-service.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';
import { expectMcpError } from '../helpers/expect-error.js';
import { serveRefsList } from '../helpers/pbdb-refs.js';

const params = referenceResource.params;
if (!params) throw new Error('the reference resource must declare a params schema.');

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  serveRefsList(fetchMock);
  vi.stubGlobal('fetch', fetchMock);
  initPbdbService(parseConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paleobiology://reference/{reference_no}', () => {
  it('returns the same record as paleobiology_get_references, plus the CC BY attribution', async () => {
    const ctx = createMockContext({ errors: referenceResource.errors });
    const result = await referenceResource.handler(params.parse({ reference_no: '149' }), ctx);

    const viaTool = await runToolContract(getReferencesTool, { reference_nos: [149] });
    const toolRecord = (viaTool.structuredContent as { references: unknown[] }).references[0];
    expect(result).toEqual({ ...(toolRecord as object), attribution: PBDB_ATTRIBUTION });
    expect(result).toMatchObject({ reference_no: 149, issue: '3-4' });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('ref_id')).toBe('149');
  });

  it('fails reference_not_found with the declared recovery when PBDB has no such reference', async () => {
    const ctx = createMockContext({ errors: referenceResource.errors });
    const err = await expectMcpError(() =>
      referenceResource.handler(params.parse({ reference_no: '999999999' }), ctx),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No PBDB reference with reference_no 999999999.');
    expect(err.data).toEqual({
      reason: 'reference_not_found',
      recovery: {
        hint: 'Take a reference_no from a paleobiology_search_occurrences or paleobiology_search_collections row, then retry.',
      },
    });
  });

  it('rejects anything but a positive integer reference_no at the param boundary', () => {
    for (const bad of ['abc', '1.5', '-1', '', '0', '99999999999999999999']) {
      expect(() => params.parse({ reference_no: bad }), bad).toThrow(
        'reference_no must be a positive integer.',
      );
    }
    expect(params.parse({ reference_no: '149' })).toEqual({ reference_no: '149' });
  });
});
