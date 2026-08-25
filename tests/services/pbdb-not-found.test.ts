/**
 * @fileoverview Hardening tests for the PBDB service's upstream-error handling —
 * the path that must sanitize EVERY error fetchWithTimeout throws into a clean
 * typed domain error that leaks NONE of the raw upstream plumbing (statusCode,
 * statusText, responseBody, requestId, internal URL) to the agent. Covers both
 * not-found reclassification (HTTP 404, the taxa/single-only 400, and PBDB's
 * HTTP-200-with-errors[] quirk), the parameter-400s on every other endpoint that
 * must surface as InvalidParams rather than masquerade as "no match", AND the
 * non-not-found upstream failures (403/429/5xx/timeout/network) that the
 * framework would otherwise forward verbatim. Drives the REAL PbdbService with a
 * mocked fetchWithTimeout, so the genuine sanitizeUpstreamError / parseEnvelope
 * code runs — no network.
 *
 * withRetry's default predicate treats NotFound/Forbidden as non-transient, so
 * those resolve immediately; the transient cases (429/5xx/timeout/network) mock
 * a rejection for every attempt and assert the exhausted error is still clean.
 *
 * The final block covers the other half of the same parse: the envelope metadata
 * that arrives ALONGSIDE a successful result — `warnings[]` (PBDB ignored part of
 * the query) and the `rowcount` counters (`records_found`) — which the parser
 * must carry out rather than drop.
 * @module tests/services/pbdb-not-found
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A spy standing in for the framework's fetchWithTimeout. */
const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout };
});

const { PbdbService, isNotFoundError } = await import('@/services/pbdb/pbdb-service.js');
const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');

/** Maps an HTTP status to the JsonRpcErrorCode fetchWithTimeout assigns (a subset). */
function codeForStatus(statusCode: number): JsonRpcErrorCode {
  switch (statusCode) {
    case 400:
      return JsonRpcErrorCode.InvalidParams;
    case 403:
      return JsonRpcErrorCode.Forbidden;
    case 404:
      return JsonRpcErrorCode.NotFound;
    case 429:
      return JsonRpcErrorCode.RateLimited;
    default:
      return JsonRpcErrorCode.ServiceUnavailable;
  }
}

/**
 * The McpError shape fetchWithTimeout throws on a non-2xx response — carrying the
 * raw upstream plumbing in `data` and the fetched URL in the message. The exact
 * leak surface this server must NOT forward to the client.
 */
function httpError(statusCode: number, body: string): McpError {
  return new McpError(
    codeForStatus(statusCode),
    `Fetch failed for https://paleobiodb.org/data1.2/taxa/single. Status: ${statusCode}`,
    {
      requestId: 'req-internal-abc123',
      operation: 'fetchOp',
      statusCode,
      statusText: 'Upstream Error',
      responseBody: body,
      errorSource: 'FetchHttpError',
    },
  );
}

/** The McpError shape fetchWithTimeout throws on a timeout — carries requestId/operation. */
function timeoutError(): McpError {
  return new McpError(JsonRpcErrorCode.Timeout, 'fetch GET https://paleobiodb.org/… timed out.', {
    requestId: 'req-internal-timeout',
    operation: 'fetchOp',
    errorSource: 'FetchTimeout',
  });
}

/** The McpError shape fetchWithTimeout throws on a network error. */
function networkError(): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    'Network error during fetch GET https://paleobiodb.org/…: ECONNREFUSED',
    {
      requestId: 'req-internal-net',
      operation: 'fetchOp',
      originalErrorName: 'TypeError',
      errorSource: 'FetchNetworkErrorWrapper',
    },
  );
}

/** Field names that, if present on a client-facing error's `data`, are a leak. */
const LEAK_FIELDS = [
  'statusCode',
  'statusText',
  'responseBody',
  'requestId',
  'errorSource',
] as const;

/** Assert a client-facing McpError carries none of the raw upstream plumbing. */
function expectNoLeak(err: McpError, internalUrlFragment = 'paleobiodb.org/data1.2'): void {
  for (const field of LEAK_FIELDS) {
    expect(err.data).not.toHaveProperty(field);
  }
  // The internal request URL must not survive into the client-facing message.
  expect(err.message).not.toContain(internalUrlFragment);
  expect(err.message).not.toContain('Fetch failed for');
}

/** A 200 OK Response whose JSON body carries an errors[] array (PBDB's quirk). */
function okJson(payload: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as Response;
}

const service = new PbdbService({} as never);

describe('PbdbService not-found reclassification', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reclassifies a taxa/single 400 + PBDB errors[] body into a clean NotFound (no raw status leak)', async () => {
    // `taxa/single` is the one endpoint that answers an unmatched lookup with a
    // 400 — a name failing PBDB's scientific-name pattern. That stays not-found.
    fetchWithTimeout.mockRejectedValue(
      httpError(400, JSON.stringify({ errors: ["Invalid taxon name 'Bogus name foo bar'"] })),
    );
    const ctx = createMockContext();

    const err = (await service
      .getTaxon({ name: 'Bogus name foo bar', showChildren: false }, ctx)
      .catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(isNotFoundError(err)).toBe(true);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    // The PBDB error message is preserved...
    expect(err.message).toMatch(/Invalid taxon name/);
    // ...but the raw HTTP plumbing is stripped — only the reason remains.
    expect(err.data).toEqual({ reason: 'pbdb_not_found' });
    for (const field of LEAK_FIELDS) {
      expect(err.data).not.toHaveProperty(field);
    }
    expectNoLeak(err);
  });

  it('classifies a list-endpoint parameter 400 as InvalidParams, NOT as not-found', async () => {
    // Every endpoint other than taxa/single reserves 400 + errors[] for a
    // malformed PARAMETER. Blanket-mapping those to not-found told the agent its
    // query matched nothing when PBDB had in fact refused to run it.
    fetchWithTimeout.mockRejectedValue(
      httpError(
        400,
        JSON.stringify({
          errors: ["you must specify both of 'lngmin' and 'lngmax' if you specify either of them"],
        }),
      ),
    );
    const ctx = createMockContext();

    const err = (await (async () => {
      try {
        for await (const _ of service.searchOccurrences(
          { limit: 100, offset: 0, lngmin: -130 },
          ctx,
        ).rows);
        return;
      } catch (e) {
        return e as McpError;
      }
    })()) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(isNotFoundError(err)).toBe(false);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    // PBDB's own rejection text is preserved so the agent can act on it...
    expect(err.message).toMatch(/lngmin.*lngmax/);
    expect(err.data).toMatchObject({ reason: 'pbdb_invalid_parameter' });
    // ...with none of the raw upstream plumbing.
    expectNoLeak(err);
  });

  it('classifies a diversity parameter 400 as InvalidParams (inverted Ma range)', async () => {
    fetchWithTimeout.mockRejectedValue(
      httpError(
        400,
        JSON.stringify({
          errors: ["The value of 'min_ma' is greater than or equal to the value of 'max_ma'."],
        }),
      ),
    );
    const ctx = createMockContext();
    const err = (await service
      .getDiversity(
        { baseName: 'Tyrannosaurus', count: 'genera', resolution: 'period', maxMa: 66, minMa: 100 },
        ctx,
      )
      .catch((e) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data).toMatchObject({ reason: 'pbdb_invalid_parameter' });
    expect(isNotFoundError(err)).toBe(false);
  });

  it('marks a single-record lookup 404 as an expected status so it logs at debug', async () => {
    // A missing record is an ordinary outcome for taxa/single and occs/single —
    // the framework logs listed statuses at debug instead of error. List
    // endpoints declare none: a non-2xx there is a genuine fault.
    fetchWithTimeout.mockResolvedValue(okJson({ records: [{ occurrence_no: '1' }] }));
    const ctx = createMockContext();
    await service.getOccurrence(139292, ctx);
    expect(fetchWithTimeout.mock.calls[0]?.[3]).toMatchObject({ expectedStatuses: [404] });

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValue(okJson({ records: [{ taxon_no: '1' }] }));
    await service.getTaxon({ name: 'Tyrannosaurus', showChildren: false }, ctx);
    expect(fetchWithTimeout.mock.calls[0]?.[3]).toMatchObject({ expectedStatuses: [400, 404] });

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    for await (const _ of service.searchOccurrences(
      { limit: 10, offset: 0, baseName: 'Canis' },
      ctx,
    ).rows);
    expect(fetchWithTimeout.mock.calls[0]?.[3]).toMatchObject({ expectedStatuses: [] });
  });

  it('reclassifies a 404 (unknown id) into a clean NotFound', async () => {
    fetchWithTimeout.mockRejectedValue(httpError(404, '{}'));
    const ctx = createMockContext();
    const err = (await service.getOccurrence(999999999, ctx).catch((e) => e)) as McpError;
    expect(isNotFoundError(err)).toBe(true);
    expect(err.data).toEqual({ reason: 'pbdb_not_found' });
  });

  it('treats a 200 OK with an errors[] body as NotFound (PBDB quirk)', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({ errors: ['No records found for the specified query.'] }),
    );
    const ctx = createMockContext();
    const err = (await service
      .getTaxon({ taxonNo: 12345, showChildren: false }, ctx)
      .catch((e) => e)) as McpError;
    expect(isNotFoundError(err)).toBe(true);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'pbdb_not_found' });
  });

  it('throws a typed NotFound when PBDB returns an empty records[] for a single lookup', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();
    const err = (await service
      .getTaxon({ name: 'Emptyresult', showChildren: false }, ctx)
      .catch((e) => e)) as McpError;
    expect(isNotFoundError(err)).toBe(true);
    expect(err.data?.reason).toBe('taxon_not_found');
  });

  it('returns an empty list (not an error) when a search yields no occurrences', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();
    const rows = [];
    for await (const row of service.searchOccurrences({ limit: 100, offset: 0 }, ctx).rows)
      rows.push(row);
    expect(rows).toEqual([]);
  });

  it('parses a successful records[] payload into normalized occurrences', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: [
          {
            occurrence_no: '139292',
            accepted_name: 'Tyrannosaurus rex',
            lng: '-113.0289',
            lat: '51.9064',
            max_ma: 72.2,
            min_ma: 66,
          },
        ],
      }),
    );
    const ctx = createMockContext();
    const rows = [];
    for await (const row of service.searchOccurrences({ limit: 100, offset: 0 }, ctx).rows)
      rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_no: 139292, accepted_name: 'Tyrannosaurus rex' });
    expect(rows[0]?.lng).toBeCloseTo(-113.0289);
  });

  it('passes coll_id to PBDB when a collection_no filter is set (drilldown)', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();
    for await (const _ of service.searchOccurrences(
      { limit: 50, offset: 0, collectionNo: 11917 },
      ctx,
    ).rows);
    const url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('coll_id')).toBe('11917');
  });

  it('over-fetches one child row and flags truncation only when it comes back (#15)', async () => {
    // The boundary case: PBDB's `taxa/list` reports records_found as
    // min(limit, true_total), so the ONLY same-request truncation signal is
    // whether the 201st row exists. 200 real children must NOT read as truncated.
    const ctx = createMockContext();
    const taxonRecord = { taxon_no: '10637', taxon_rank: 'genus', accepted_name: 'Turritella' };
    const kids = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ taxon_no: String(500_000 + i), taxon_name: `c${i}` }));

    for (const [returned, expectTruncated, expectChildren] of [
      [200, false, 200],
      [201, true, 200],
      [3, false, 3],
    ] as const) {
      fetchWithTimeout.mockReset();
      fetchWithTimeout
        .mockResolvedValueOnce(okJson({ records: [taxonRecord] }))
        .mockResolvedValueOnce(okJson({ records: kids(returned) }));

      const taxon = await service.getTaxon({ taxonNo: 10637, showChildren: true }, ctx);
      expect(taxon.children).toHaveLength(expectChildren);
      expect(taxon.children_truncated).toBe(expectTruncated);
      expect(taxon.children_offset).toBe(0);

      // One extra row is requested, never 200 — that is what makes the flag honest.
      const childUrl = fetchWithTimeout.mock.calls[1]?.[0] as URL;
      expect(childUrl.pathname).toContain('taxa/list');
      expect(childUrl.searchParams.get('limit')).toBe('201');
      expect(childUrl.searchParams.get('rel')).toBe('children');
      expect(childUrl.searchParams.get('offset')).toBe('0');
      // Exactly two upstream calls — no `limit=0` preflight for an exact count.
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    }
  });

  it('sends childrenOffset on the child page and echoes it back (#15)', async () => {
    const ctx = createMockContext();
    fetchWithTimeout
      .mockResolvedValueOnce(
        okJson({
          records: [{ taxon_no: '10637', taxon_rank: 'genus', accepted_name: 'Turritella' }],
        }),
      )
      .mockResolvedValueOnce(okJson({ records: [{ taxon_no: '777', taxon_name: 'later child' }] }));

    const taxon = await service.getTaxon(
      { taxonNo: 10637, showChildren: true, childrenOffset: 200 },
      ctx,
    );
    const childUrl = fetchWithTimeout.mock.calls[1]?.[0] as URL;
    expect(childUrl.searchParams.get('offset')).toBe('200');
    expect(taxon.children_offset).toBe(200);
    expect(taxon.children_truncated).toBe(false);
    expect(taxon.children?.[0]).toMatchObject({ taxon_no: 777, name: 'later child' });
  });

  it('leaves the children fields unset when no child lookup was requested (#15)', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: [{ taxon_no: '54833', taxon_rank: 'genus', accepted_name: 'Tyrannosaurus' }],
      }),
    );
    const ctx = createMockContext();
    const taxon = await service.getTaxon({ taxonNo: 54833, showChildren: false }, ctx);

    expect(taxon.children).toBeUndefined();
    expect(taxon.children_offset).toBeUndefined();
    expect(taxon.children_truncated).toBeUndefined();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('sends offset on the occurrence query (#14)', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();
    for await (const _ of service.searchOccurrences(
      { limit: 50, offset: 150, baseName: 'Dinosauria' },
      ctx,
    ).rows);
    const url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('offset')).toBe('150');
    expect(url.searchParams.get('limit')).toBe('50');
    // `rowcount` is what keeps the total independent of the page being read.
    expect(url.searchParams.get('rowcount')).toBe('1');
  });

  it('renders baseId as PBDB txn:<n> on all three taxon-filtered endpoints (#20)', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();

    for await (const _ of service.searchOccurrences({ limit: 10, offset: 0, baseId: 38613 }, ctx)
      .rows);
    let url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toContain('occs/list');
    expect(url.searchParams.get('base_id')).toBe('txn:38613');
    expect(url.searchParams.has('base_name')).toBe(false);

    fetchWithTimeout.mockClear();
    await service.searchCollections({ limit: 10, offset: 0, baseId: 38613 }, ctx);
    url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toContain('colls/list');
    expect(url.searchParams.get('base_id')).toBe('txn:38613');
    expect(url.searchParams.has('base_name')).toBe(false);

    fetchWithTimeout.mockClear();
    await service.getDiversity({ baseId: 52775, count: 'genera', resolution: 'period' }, ctx);
    url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toContain('occs/diversity');
    expect(url.searchParams.get('base_id')).toBe('txn:52775');
    expect(url.searchParams.has('base_name')).toBe(false);
  });
});

describe('PbdbService upstream-error sanitization (no leak on non-not-found failures)', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sanitizes a 403 Forbidden — preserves the code, leaks no upstream plumbing', async () => {
    fetchWithTimeout.mockRejectedValue(httpError(403, 'Forbidden by upstream WAF'));
    const ctx = createMockContext();

    const err = (await service
      .getTaxon({ name: 'Tyrannosaurus', showChildren: false }, ctx)
      .catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    // Forbidden is non-transient, so it surfaces immediately with the same code…
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    // …but none of the raw upstream plumbing reaches the client.
    expectNoLeak(err);
    expect(err.data).not.toHaveProperty('responseBody');
    expect(err.message).not.toContain('WAF');
    // The original framework error is retained as `cause` for server-side logging.
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(McpError);
  });

  it('does not surface the upstream responseBody for any non-not-found status', async () => {
    fetchWithTimeout.mockRejectedValue(
      httpError(403, JSON.stringify({ secret: 'internal upstream detail' })),
    );
    const ctx = createMockContext();
    const err = (await service.getOccurrence(123, ctx).catch((e) => e)) as McpError;
    expect(JSON.stringify(err.data ?? {})).not.toContain('internal upstream detail');
    expect(JSON.stringify(err.data ?? {})).not.toContain('req-internal');
  });

  it('sanitizes an exhausted 500 ServiceUnavailable after retries — still no leak', async () => {
    vi.useFakeTimers();
    fetchWithTimeout.mockRejectedValue(httpError(500, 'Internal Server Error stack trace…'));
    const ctx = createMockContext();

    const promise = service
      .getDiversity({ baseName: 'Dinosauria', count: 'genera', resolution: 'period' }, ctx)
      .catch((e) => e);
    // Drive the retry backoff to exhaustion without real wall-clock delay.
    await vi.runAllTimersAsync();
    const err = (await promise) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expectNoLeak(err);
    expect(err.message).not.toContain('stack trace');
    // retryAttempts is allowed (added by withRetry on exhaustion) but must be the
    // ONLY plumbing-ish field — the upstream identifiers are gone.
    expect(err.data).not.toHaveProperty('statusCode');
    expect(err.data).not.toHaveProperty('requestId');
  });

  it('sanitizes an exhausted 429 RateLimited after retries — preserves the code, no leak', async () => {
    vi.useFakeTimers();
    fetchWithTimeout.mockRejectedValue(httpError(429, 'Too Many Requests'));
    const ctx = createMockContext();

    const promise = service
      .searchCollections({ limit: 100, offset: 0, baseName: 'Dinosauria' }, ctx)
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = (await promise) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expectNoLeak(err);
  });

  it('sanitizes a timeout — preserves the Timeout code, leaks no requestId', async () => {
    vi.useFakeTimers();
    fetchWithTimeout.mockRejectedValue(timeoutError());
    const ctx = createMockContext();

    const promise = service
      .getTaxon({ name: 'Ammonoidea', showChildren: false }, ctx)
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = (await promise) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expectNoLeak(err, 'paleobiodb.org');
    expect(err.data).not.toHaveProperty('requestId');
  });

  it('sanitizes a network error — preserves ServiceUnavailable, no internal detail', async () => {
    vi.useFakeTimers();
    fetchWithTimeout.mockRejectedValue(networkError());
    const ctx = createMockContext();

    // searchOccurrences hands back a row generator — draining it triggers the fetch.
    const drained = (async () => {
      try {
        for await (const _ of service.searchOccurrences(
          { limit: 100, offset: 0, baseName: 'Dinosauria' },
          ctx,
        ).rows);
        return;
      } catch (e) {
        return e as McpError;
      }
    })();
    await vi.runAllTimersAsync();
    const err = (await drained) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expectNoLeak(err, 'paleobiodb.org');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.data).not.toHaveProperty('originalErrorName');
  });
});

describe('PbdbService envelope metadata (warnings + rowcount totals)', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fake `colls/list` page of n rows, numbered from 1. */
  function collectionRows(n: number): { collection_no: string }[] {
    return Array.from({ length: n }, (_, i) => ({ collection_no: String(i + 1) }));
  }

  it('requests rowcount on both list searches so PBDB reports the true match count', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [], records_found: 0 }));
    const ctx = createMockContext();

    await service.searchCollections({ limit: 100, offset: 0, baseName: 'Dinosauria' }, ctx);
    const collUrl = fetchWithTimeout.mock.calls[0]?.[0] as URL | undefined;
    expect(collUrl?.searchParams.get('rowcount')).toBe('1');

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValue(okJson({ records: [], records_found: 0 }));
    for await (const _ of service.searchOccurrences(
      { limit: 100, offset: 0, baseName: 'Dinosauria' },
      ctx,
    ).rows);
    const occUrl = fetchWithTimeout.mock.calls[0]?.[0] as URL | undefined;
    expect(occUrl?.searchParams.get('rowcount')).toBe('1');
  });

  it('carries warnings[] out of a 200 that also returned a full record set', async () => {
    // The silent-correctness case: an unrecognized lithology is DROPPED from the
    // query, so PBDB answers with the whole unfiltered set plus a warning.
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: collectionRows(3),
        records_found: 1950,
        records_returned: 3,
        warnings: [
          "there are no records with lithology or lithology type 'garbagexyz' in the database",
        ],
      }),
    );
    const ctx = createMockContext();
    const result = await service.searchCollections(
      { limit: 3, offset: 0, baseName: 'Dinosauria', lithology: 'GARBAGEXYZ' },
      ctx,
    );

    expect(result.warnings).toEqual([
      "there are no records with lithology or lithology type 'garbagexyz' in the database",
    ]);
    expect(result.total).toBe(1950);
    expect(result.shown).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('reports no warnings when PBDB applied every filter', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({ records: collectionRows(3), records_found: 653, records_returned: 3 }),
    );
    const ctx = createMockContext();
    const result = await service.searchCollections(
      { limit: 3, offset: 0, baseName: 'Dinosauria', lithology: 'sandstone' },
      ctx,
    );

    expect(result.warnings).toBeUndefined();
    expect(result.total).toBe(653);
  });

  it('derives truncation from the true total, not from a page that filled the limit', async () => {
    // The false positive this replaces: a final page of exactly `limit` rows with
    // nothing left upstream. `shown >= cap` called that truncated; the total says no.
    fetchWithTimeout.mockResolvedValue(
      okJson({ records: collectionRows(84), records_found: 84, records_returned: 84 }),
    );
    const ctx = createMockContext();
    const result = await service.searchCollections(
      { limit: 84, offset: 0, baseName: 'Tyrannosaurus' },
      ctx,
    );

    expect(result.shown).toBe(84);
    expect(result.cap).toBe(84);
    expect(result.total).toBe(84);
    expect(result.truncated).toBe(false);
  });

  it('accounts for offset when deciding whether records remain', async () => {
    // PBDB emits a NEGATIVE records_returned once offset runs past the end
    // (limit - (offset - records_found)); the row count and offset decide instead.
    fetchWithTimeout.mockResolvedValue(
      okJson({ records: collectionRows(4), records_found: 84, records_returned: 4 }),
    );
    const ctx = createMockContext();
    const lastPage = await service.searchCollections(
      { limit: 100, offset: 80, baseName: 'Tyrannosaurus' },
      ctx,
    );
    expect(lastPage.truncated).toBe(false);
    expect(lastPage.offset).toBe(80);

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValue(
      okJson({ records: [], records_found: 84, records_returned: -116 }),
    );
    const pastEnd = await service.searchCollections(
      { limit: 10, offset: 200, baseName: 'Tyrannosaurus' },
      ctx,
    );
    expect(pastEnd.shown).toBe(0);
    expect(pastEnd.truncated).toBe(false);
    expect(pastEnd.total).toBe(84);
  });

  it('exposes the occurrence total and warnings on the handle after the stream drains', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: [{ occurrence_no: '1' }, { occurrence_no: '2' }],
        records_found: 4170,
        records_returned: 2,
      }),
    );
    const ctx = createMockContext();
    const search = service.searchOccurrences(
      { limit: 2, offset: 0, baseName: 'Dinosauria', interval: 'Maastrichtian' },
      ctx,
    );
    const rows = [];
    for await (const row of search.rows) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(search.meta.recordsFound).toBe(4170);
    expect(search.meta.warnings).toBeUndefined();
  });

  it('distinguishes an unmatched occurrence name from a genuinely empty result', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: [],
        records_found: 0,
        warnings: [
          "The name 'Tyrannosauruss' did not match the currently accepted variant of any name in the taxonomy table",
        ],
      }),
    );
    const ctx = createMockContext();
    const typo = service.searchOccurrences(
      { limit: 100, offset: 0, baseName: 'Tyrannosauruss' },
      ctx,
    );
    for await (const _ of typo.rows);
    expect(typo.meta.warnings?.[0]).toMatch(/did not match the currently accepted variant/);
    expect(typo.meta.recordsFound).toBe(0);

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValue(okJson({ records: [], records_found: 0 }));
    const empty = service.searchOccurrences(
      { limit: 100, offset: 0, baseName: 'Tyrannosaurus', interval: 'Cambrian' },
      ctx,
    );
    for await (const _ of empty.rows);
    expect(empty.meta.warnings).toBeUndefined();
    expect(empty.meta.recordsFound).toBe(0);
  });

  it('carries diversity warnings alongside an empty bin set', async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        records: [],
        warnings: [
          "The name 'Dinosauriaa' did not match the currently accepted variant of any name in the taxonomy table",
        ],
      }),
    );
    const ctx = createMockContext();
    const result = await service.getDiversity(
      { baseName: 'Dinosauriaa', count: 'genera', resolution: 'period' },
      ctx,
    );

    expect(result.bins).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/did not match/);
  });

  it('still throws NotFound when errors[] arrives, even alongside warnings[]', async () => {
    // errors[] replaces a result; warnings[] accompanies one. The two must not
    // be conflated now that both are read off the same envelope.
    fetchWithTimeout.mockResolvedValue(
      okJson({
        errors: ['No records found for the specified query.'],
        warnings: ['ignored a filter'],
      }),
    );
    const ctx = createMockContext();
    const err = (await service
      .getTaxon({ taxonNo: 12345, showChildren: false }, ctx)
      .catch((e) => e)) as McpError;

    expect(isNotFoundError(err)).toBe(true);
    expect(err.message).toMatch(/No records found/);
  });
});
