/**
 * @fileoverview Hardening tests for the PBDB service's not-found handling —
 * the path that must reclassify an upstream 4xx (and PBDB's HTTP-200-with-
 * errors[] quirk) into a clean typed NotFound that leaks NONE of the raw
 * upstream plumbing (statusCode, statusText, responseBody, requestId) to the
 * agent. Drives the REAL PbdbService with a mocked fetchWithTimeout, so the
 * genuine reclassifyPbdbHttpError / parseEnvelope code runs — no network.
 *
 * withRetry's default predicate treats NotFound as non-transient, so these
 * resolve immediately without spinning the retry loop.
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

/** The McpError shape fetchWithTimeout throws on a non-2xx response. */
function httpError(statusCode: number, body: string): McpError {
  return new McpError(
    statusCode === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.ValidationError,
    `PBDB request failed with status ${statusCode}.`,
    { statusCode, statusText: 'Bad Request', responseBody: body },
  );
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

  it('reclassifies a 400 + PBDB errors[] body into a clean NotFound (no raw status leak)', async () => {
    fetchWithTimeout.mockRejectedValue(
      httpError(400, JSON.stringify({ errors: ["Unknown taxon name 'Bogusname'"] })),
    );
    const ctx = createMockContext();

    const err = (await service
      .getTaxon({ name: 'Bogusname', showChildren: false }, ctx)
      .catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(isNotFoundError(err)).toBe(true);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    // The PBDB error message is preserved...
    expect(err.message).toMatch(/Unknown taxon name/);
    // ...but the raw HTTP plumbing is stripped — only the reason remains.
    expect(err.data).toEqual({ reason: 'pbdb_not_found' });
    expect(err.data).not.toHaveProperty('statusCode');
    expect(err.data).not.toHaveProperty('statusText');
    expect(err.data).not.toHaveProperty('responseBody');
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
});
