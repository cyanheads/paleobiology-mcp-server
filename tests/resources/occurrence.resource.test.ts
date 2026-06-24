/**
 * @fileoverview Tests for the paleobiology://occurrence/{occurrence_no} and
 * paleobiology://taxon/{taxon_no} resources. Covers the happy path, the
 * not-found contract remap (occurrence_not_found / taxon_not_found), the
 * no-leak hardening (a clean typed not-found carries only its reason — never
 * the upstream statusCode/responseBody/requestId), the param regex rejecting
 * non-integer ids, and a non-not-found error bubbling unchanged.
 *
 * getPbdbService() is mocked per-test; isNotFoundError() (the real predicate
 * the resources remap on) stays live via importActual.
 * @module tests/resources/occurrence.resource
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Occurrence, Taxon } from '@/services/pbdb/types.js';

const getOccurrence = vi.fn();
const getTaxon = vi.fn();

vi.mock('@/services/pbdb/pbdb-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/pbdb/pbdb-service.js')>();
  return { ...actual, getPbdbService: () => ({ getOccurrence, getTaxon }) };
});

const { occurrenceResource } = await import(
  '@/mcp-server/resources/definitions/occurrence.resource.js'
);
const { taxonResource } = await import('@/mcp-server/resources/definitions/taxon.resource.js');

describe('paleobiology://occurrence/{occurrence_no}', () => {
  beforeEach(() => {
    getOccurrence.mockReset();
  });

  it('returns the occurrence record for a valid id', async () => {
    const occ: Occurrence = {
      occurrence_no: 139292,
      accepted_name: 'Tyrannosaurus rex',
      max_ma: 72.2,
      min_ma: 66,
    };
    getOccurrence.mockResolvedValue(occ);
    const ctx = createMockContext({ errors: occurrenceResource.errors });
    const params = occurrenceResource.params.parse({ occurrence_no: '139292' });
    const result = await occurrenceResource.handler(params, ctx);

    expect(result).toMatchObject({ occurrence_no: 139292, accepted_name: 'Tyrannosaurus rex' });
    // The string param is coerced to a number before reaching the service.
    expect(getOccurrence).toHaveBeenCalledWith(139292, ctx);
  });

  it('rejects a non-integer occurrence_no at the param boundary', () => {
    expect(() => occurrenceResource.params.parse({ occurrence_no: 'abc' })).toThrow();
    expect(() => occurrenceResource.params.parse({ occurrence_no: '12.5' })).toThrow();
  });

  it('remaps a service not-found to the occurrence_not_found reason without leaking raw status', async () => {
    getOccurrence.mockRejectedValue(notFound('PBDB found no match during getOccurrence.'));
    const ctx = createMockContext({ errors: occurrenceResource.errors });
    const params = occurrenceResource.params.parse({ occurrence_no: '999999999' });

    const err = (await occurrenceResource.handler(params, ctx).catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('occurrence_not_found');
    expect(err.data).not.toHaveProperty('statusCode');
    expect(err.data).not.toHaveProperty('responseBody');
    expect(err.data).not.toHaveProperty('requestId');
    expect(JSON.stringify(err.data)).toMatch(/paleobiology_search_occurrences/);
  });

  it('bubbles a non-not-found service error unchanged', async () => {
    getOccurrence.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'PBDB is down.'),
    );
    const ctx = createMockContext({ errors: occurrenceResource.errors });
    const params = occurrenceResource.params.parse({ occurrence_no: '1' });
    await expect(occurrenceResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('paleobiology://taxon/{taxon_no}', () => {
  beforeEach(() => {
    getTaxon.mockReset();
  });

  it('returns the taxon record for a valid id (no children requested)', async () => {
    const taxon: Taxon = {
      taxon_no: 54833,
      accepted_name: 'Tyrannosaurus',
      classification: {},
      extant: false,
      range: { first_appearance: {}, last_appearance: {} },
    };
    getTaxon.mockResolvedValue(taxon);
    const ctx = createMockContext({ errors: taxonResource.errors });
    const params = taxonResource.params.parse({ taxon_no: '54833' });
    const result = await taxonResource.handler(params, ctx);

    expect(result).toMatchObject({ taxon_no: 54833, accepted_name: 'Tyrannosaurus' });
    expect(getTaxon).toHaveBeenCalledWith({ taxonNo: 54833, showChildren: false }, ctx);
  });

  it('rejects a non-integer taxon_no at the param boundary', () => {
    expect(() => taxonResource.params.parse({ taxon_no: 'Tyrannosaurus' })).toThrow();
  });

  it('remaps a service not-found to the taxon_not_found reason without leaking raw status', async () => {
    getTaxon.mockRejectedValue(notFound('PBDB found no match during getTaxon.'));
    const ctx = createMockContext({ errors: taxonResource.errors });
    const params = taxonResource.params.parse({ taxon_no: '88888888' });

    const err = (await taxonResource.handler(params, ctx).catch((e) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('taxon_not_found');
    expect(err.data).not.toHaveProperty('statusCode');
    expect(err.data).not.toHaveProperty('responseBody');
  });
});
