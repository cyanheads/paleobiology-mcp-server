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
        for await (const _ of service.searchOccurrences({ limit: 100, lngmin: -130 }, ctx));
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
    for await (const _ of service.searchOccurrences({ limit: 10, baseName: 'Canis' }, ctx));
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
    for await (const row of service.searchOccurrences({ limit: 100 }, ctx)) rows.push(row);
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
    for await (const row of service.searchOccurrences({ limit: 100 }, ctx)) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_no: 139292, accepted_name: 'Tyrannosaurus rex' });
    expect(rows[0]?.lng).toBeCloseTo(-113.0289);
  });

  it('passes coll_id to PBDB when a collection_no filter is set (drilldown)', async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ records: [] }));
    const ctx = createMockContext();
    for await (const _ of service.searchOccurrences({ limit: 50, collectionNo: 11917 }, ctx));
    const url = fetchWithTimeout.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('coll_id')).toBe('11917');
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

    // searchOccurrences is an async generator — draining it triggers the fetch.
    const drained = (async () => {
      try {
        for await (const _ of service.searchOccurrences(
          { limit: 100, baseName: 'Dinosauria' },
          ctx,
        ));
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
