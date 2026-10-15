/**
 * @fileoverview Shared `refs/list` test data: the live-captured PBDB reference
 * records in tests/fixtures/pbdb-refs-list.json (show=both,authorlist, in PBDB's
 * author order) and a fetch fake that answers `refs/list` the way the live
 * endpoint does.
 * @module tests/helpers/pbdb-refs
 */

import { readFileSync } from 'node:fs';
import type { Mock } from 'vitest';
import type { PbdbReferenceRecord } from '@/services/pbdb/types.js';

/** Live `refs/list` records, in PBDB's author order. */
export const REFS_FIXTURE = (
  JSON.parse(readFileSync(new URL('../fixtures/pbdb-refs-list.json', import.meta.url), 'utf8')) as {
    records: PbdbReferenceRecord[];
  }
).records;

/**
 * Answer `refs/list` like PBDB: the records whose id is in `ref_id`, in the order
 * `records` holds them, misses omitted. Any other request is an unmocked call.
 */
export function serveRefsList(
  fetchMock: Mock<typeof fetch>,
  records: PbdbReferenceRecord[] = REFS_FIXTURE,
): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'paleobiodb.org' || url.pathname !== '/data1.2/refs/list.json') {
      throw new Error('unmocked fetch');
    }
    const ids = new Set((url.searchParams.get('ref_id') ?? '').split(',').map(Number));
    return Response.json({ records: records.filter((r) => ids.has(Number(r.reference_no))) });
  });
}
