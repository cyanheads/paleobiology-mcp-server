/**
 * @fileoverview Exercises fossil-analysis tools and the taxon resource with captured PBDB records.
 * @module tests/tools/pbdb-analysis-contracts
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taxonResource } from '@/mcp-server/resources/definitions/taxon.resource.js';
import { getDiversityTool } from '@/mcp-server/tools/definitions/get-diversity.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { listIntervalsTool } from '@/mcp-server/tools/definitions/list-intervals.tool.js';
import { initIntervalIndex } from '@/services/intervals/interval-index.js';
import { initPbdbService } from '@/services/pbdb/pbdb-service.js';

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout,
}));

const compactTaxa = [
  [{ oid: 'txn:52933', nam: 'Pteranodontidae', rnk: 'family', ext: '0' }, false, 'no (extinct)'],
  [{ oid: 'txn:83088', nam: 'Homo sapiens', rnk: 3, ext: '1' }, true, 'yes'],
  [{ oid: 'txn:61625', nam: 'Parvamussium thetidis', rnk: 'species' }, undefined, 'unknown'],
] as const;

function respond(data: object) {
  fetchWithTimeout.mockImplementation(async () => new Response(JSON.stringify(data)));
}

function rendered({ content }: Awaited<ReturnType<typeof runToolContract>>): string {
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe('PBDB analysis contracts', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    initPbdbService({} as never);
    initIntervalIndex();
  });

  it.each(compactTaxa)(
    'mirrors compact extant status through tool and resource for $oid',
    async (record, status, label) => {
      respond({ records: [record] });
      const taxonNo = record.oid.slice(4);
      const tool = await runToolContract(getTaxonTool, { taxon_no: Number(taxonNo) });
      const resource = await taxonResource.handler(
        { taxon_no: taxonNo },
        createMockContext({ errors: taxonResource.errors }),
      );
      expect(tool.isError).toBeFalsy();
      if (status === undefined) {
        expect(tool.structuredContent).not.toHaveProperty('extant');
        expect(resource).not.toHaveProperty('extant');
      } else {
        expect(tool.structuredContent).toHaveProperty('extant', status);
        expect(resource).toHaveProperty('extant', status);
      }
      expect(rendered(tool)).toContain(`**extant:** ${label}`);
    },
  );

  it('serves PBDB international ages offline on both representations', async () => {
    const result = await runToolContract(listIntervalsTool, { name: 'Induan' });
    expect(result.structuredContent).toMatchObject({
      source: 'bundled_ics',
      intervals: [{ name: 'Induan', min_ma: 250.8, max_ma: 251.902 }],
    });
    expect(rendered(result)).toContain('250.8');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('requests the diversity summary and preserves sparse counters on both representations', async () => {
    respond({
      records: [{ interval_name: 'Late Pleistocene', max_ma: 0.129, min_ma: 0.0117, n_occs: 9173 }],
      summary: { n_occs: 125037, bin_total: 100416, imprecise_time: 24621, imprecise_taxon: 40372 },
    });
    const result = await runToolContract(getDiversityTool, {
      base_name: 'Mammalia',
      count: 'species',
    });
    expect(result.isError).toBeFalsy();
    const params = new URL(fetchWithTimeout.mock.calls[0]![0]).searchParams;
    expect(params.has('datainfo')).toBe(true);
    expect(params.has('timerule')).toBe(false);
    expect(result.structuredContent).toMatchObject({
      summary: { n_occs: 125037, bin_total: 100416, imprecise_time: 24621, imprecise_taxon: 40372 },
      notice: expect.stringContaining('timerule=major'),
    });
    expect(result.structuredContent).not.toHaveProperty('summary.missing_taxon');
    for (const value of ['125037', '100416', '24621', '40372', 'timerule=major']) {
      expect(rendered(result)).toContain(value);
    }
  });

  it.each(['contain', 'overlap'])(
    'applies %s with subdivision filters and echoes empty-result selectors',
    async (timerule) => {
      respond({ records: [], warnings: ['Test PBDB locality warning'] });
      const result = await runToolContract(getDiversityTool, {
        base_name: 'Dinosauria',
        country: 'US',
        state: 'Texas',
        county: 'Brewster',
        timerule,
      });
      const params = new URL(fetchWithTimeout.mock.calls[0]![0]).searchParams;
      expect(Object.fromEntries(params)).toMatchObject({
        cc: 'US',
        state: 'Texas',
        county: 'Brewster',
        timerule,
      });
      expect(result.structuredContent).not.toHaveProperty('summary');
      for (const value of [
        `timerule=${timerule}`,
        'state=Texas',
        'county=Brewster',
        'Test PBDB locality warning',
      ]) {
        expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(value) });
        expect(rendered(result)).toContain(value);
      }
    },
  );

  it('preserves a bin count above the scanned count, an explicit zero and a missing-hierarchy count', async () => {
    respond({
      records: [{ interval_name: 'Meghalayan', max_ma: 0.0042, min_ma: 0, n_occs: 8107 }],
      summary: { n_occs: 125037, bin_total: 253024, imprecise_taxon: 0, missing_taxon: 5018 },
    });
    const result = await runToolContract(getDiversityTool, {
      base_name: 'Mammalia',
      state: ' ',
      county: '',
      timerule: 'overlap',
    });
    const params = new URL(fetchWithTimeout.mock.calls[0]![0]).searchParams;
    expect(params.has('state')).toBe(false);
    expect(params.has('county')).toBe(false);
    expect(result.structuredContent).toHaveProperty('summary', {
      n_occs: 125037,
      bin_total: 253024,
      imprecise_taxon: 0,
      missing_taxon: 5018,
    });
    expect(rendered(result)).toContain('**bin_total:** 253024');
    expect(rendered(result)).toContain('**imprecise_taxon:** 0');
    expect(rendered(result)).toContain('**missing_taxon:** 5018');
  });

  it('rejects unadvertised rules before calling PBDB', async () => {
    const result = await runToolContract(getDiversityTool, {
      base_name: 'Mammalia',
      timerule: 'buffer',
    });
    expect(result.isError).toBe(true);
    expect(rendered(result)).toContain('timerule');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
