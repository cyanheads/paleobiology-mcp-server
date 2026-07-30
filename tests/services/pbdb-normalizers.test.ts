/**
 * @fileoverview Tests for the PBDB response normalizers. Covers the derived-field
 * computation (FAD/LAD windows, origination/extinction sums), string→number
 * coercion, sentinel handling (NO_ORDER_SPECIFIED, quoted lithology/environment),
 * sparse payloads (PBDB routinely omits paleo-coords, late_interval, formation —
 * absent fields stay absent, never defaulted), and the inverse case: a diversity
 * bin's interval/max_ma/min_ma are always present, so a record missing them is
 * rejected rather than emitted temporally anonymous — the same rule applies to an
 * upstream-resolved interval, whose b_age/t_age invert into max_ma/min_ma and
 * whose scale_no resolves to a scale name.
 * @module tests/services/pbdb-normalizers
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeCollection,
  normalizeDiversityBin,
  normalizeInterval,
  normalizeOccurrence,
  normalizeTaxon,
  normalizeTaxonStub,
} from '@/services/pbdb/pbdb-service.js';
import type {
  PbdbCollectionRecord,
  PbdbDiversityRecord,
  PbdbIntervalRecord,
  PbdbOccurrenceRecord,
  PbdbTaxonRecord,
} from '@/services/pbdb/types.js';

describe('normalizeOccurrence', () => {
  it('normalizes a full record, coercing string numbers and both coordinate systems', () => {
    const raw: PbdbOccurrenceRecord = {
      occurrence_no: '139292',
      collection_no: '11917',
      identified_name: 'Tyrannosaurus rex',
      identified_rank: 'species',
      accepted_name: 'Tyrannosaurus rex',
      accepted_rank: 'species',
      accepted_no: '54833',
      early_interval: 'Late Maastrichtian',
      max_ma: 72.2,
      min_ma: 66,
      lng: '-113.028900',
      lat: '51.906399',
      paleolng: -68.22,
      paleolat: 64.06,
      paleomodel: 'gplates',
      geoplate: '101',
      formation: 'Scollard',
      cc: 'CA',
      state: 'Alberta',
      order: 'NO_ORDER_SPECIFIED',
      class: 'Reptilia',
      family: 'Tyrannosauridae',
      genus: 'Tyrannosaurus',
      reference_no: '4218',
    };
    const o = normalizeOccurrence(raw);
    expect(o.occurrence_no).toBe(139292);
    expect(o.collection_no).toBe(11917);
    expect(o.accepted_no).toBe(54833);
    // Modern and paleo coordinates both surfaced, distinctly.
    expect(o.lng).toBeCloseTo(-113.0289);
    expect(o.lat).toBeCloseTo(51.9064);
    expect(o.paleolng).toBe(-68.22);
    expect(o.paleolat).toBe(64.06);
    expect(o.paleomodel).toBe('gplates');
    // The NO_ORDER_SPECIFIED sentinel is dropped from classification.
    expect(o.classification).toEqual({
      class: 'Reptilia',
      family: 'Tyrannosauridae',
      genus: 'Tyrannosaurus',
    });
  });

  it('preserves absence on a sparse record — no paleo-coords, no late_interval, no formation', () => {
    const raw: PbdbOccurrenceRecord = {
      occurrence_no: '500',
      accepted_name: 'Some taxon',
      early_interval: 'Cambrian',
      max_ma: 500,
      min_ma: 485,
    };
    const o = normalizeOccurrence(raw);
    expect(o.occurrence_no).toBe(500);
    expect(o.accepted_name).toBe('Some taxon');
    // Absent upstream fields must NOT be defaulted to 0/'' — they stay undefined.
    expect(o).not.toHaveProperty('paleolng');
    expect(o).not.toHaveProperty('paleolat');
    expect(o).not.toHaveProperty('late_interval');
    expect(o).not.toHaveProperty('formation');
    expect(o).not.toHaveProperty('lng');
    expect(o).not.toHaveProperty('classification');
  });
});

describe('normalizeTaxon', () => {
  it('builds FAD/LAD windows and reads extant from is_extant', () => {
    const raw: PbdbTaxonRecord = {
      orig_no: '38613',
      taxon_no: '38613',
      taxon_rank: 'genus',
      accepted_name: 'Tyrannosaurus',
      parent_no: '92294',
      parent_name: 'Tyrannosaurini',
      is_extant: 'extinct',
      n_occs: 86,
      firstapp_max_ma: 83.6,
      firstapp_min_ma: 72.2,
      lastapp_max_ma: 72.2,
      lastapp_min_ma: 66,
      early_interval: 'Campanian',
      late_interval: 'Maastrichtian',
      class: 'Reptilia',
      family: 'Tyrannosauridae',
    };
    const t = normalizeTaxon(raw);
    expect(t.taxon_no).toBe(38613);
    expect(t.rank).toBe('genus');
    expect(t.extant).toBe(false);
    expect(t.occurrence_count).toBe(86);
    expect(t.range.first_appearance).toEqual({ max_ma: 83.6, min_ma: 72.2, interval: 'Campanian' });
    expect(t.range.last_appearance).toEqual({
      max_ma: 72.2,
      min_ma: 66,
      interval: 'Maastrichtian',
    });
  });

  it('falls back to accepted_rank when taxon_rank is null (the by-id lookup shape)', () => {
    // A by-id PBDB lookup (taxa/single?id=txn:NNN) returns taxon_rank: null and
    // carries the rank in accepted_rank instead — the by-name shape populates
    // taxon_rank. Without the fallback, get_taxon by taxon_no and the taxon
    // resource drop the rank entirely.
    const raw: PbdbTaxonRecord = {
      taxon_no: '38613',
      accepted_name: 'Tyrannosaurus',
      accepted_rank: 'genus',
      is_extant: 'extinct',
    };
    const t = normalizeTaxon(raw);
    expect(t.rank).toBe('genus');
  });

  it('marks an extant clade and tolerates a missing appearance window', () => {
    const raw: PbdbTaxonRecord = {
      taxon_no: '36651',
      taxon_rank: 'genus',
      accepted_name: 'Homo',
      is_extant: 'extant',
    };
    const t = normalizeTaxon(raw);
    expect(t.extant).toBe(true);
    // No FAD/LAD data — windows are empty objects, not fabricated zeros.
    expect(t.range.first_appearance).toEqual({});
    expect(t.range.last_appearance).toEqual({});
    expect(t).not.toHaveProperty('occurrence_count');
  });
});

describe('normalizeTaxonStub', () => {
  it('flags a synonym child', () => {
    const raw: PbdbTaxonRecord = {
      taxon_no: '67659',
      taxon_name: 'Shanshanosaurinae',
      accepted_rank: 'subfamily',
      accepted_name: 'Tyrannosaurinae',
      difference: 'subjective synonym of',
      n_occs: 211,
    };
    const s = normalizeTaxonStub(raw);
    expect(s.taxon_no).toBe(67659);
    expect(s.name).toBe('Shanshanosaurinae');
    expect(s.synonym_of).toBe('Tyrannosaurinae');
  });

  it('does not flag a non-synonym child', () => {
    const raw: PbdbTaxonRecord = {
      taxon_no: '57248',
      taxon_name: 'Bagaraatan',
      accepted_name: 'Bagaraatan',
      accepted_rank: 'genus',
    };
    const s = normalizeTaxonStub(raw);
    expect(s).not.toHaveProperty('synonym_of');
  });
});

describe('normalizeDiversityBin', () => {
  it('computes originations (X_Ft + X_FL) and extinctions (X_bL + X_FL)', () => {
    const raw: PbdbDiversityRecord = {
      interval_no: '14',
      interval_name: 'Cretaceous',
      max_ma: 143.1,
      min_ma: 66,
      X_Ft: 0,
      X_bL: 52,
      X_FL: 1276,
      X_bt: 0,
      sampled_in_bin: 1328,
      implied_in_bin: 44,
      n_occs: 16198,
    };
    const b = normalizeDiversityBin(raw);
    expect(b.interval).toBe('Cretaceous');
    expect(b.originations).toBe(1276); // 0 + 1276
    expect(b.extinctions).toBe(1328); // 52 + 1276
    expect(b.range_through).toBe(0);
    expect(b.sampled_in_bin).toBe(1328);
    expect(b.implied).toBe(44);
    expect(b.n_occurrences).toBe(16198);
  });

  it('treats missing counts as zero (a bin with no turnover)', () => {
    const raw: PbdbDiversityRecord = { interval_name: 'Empty', max_ma: 10, min_ma: 5 };
    const b = normalizeDiversityBin(raw);
    expect(b.originations).toBe(0);
    expect(b.extinctions).toBe(0);
    expect(b.sampled_in_bin).toBe(0);
  });

  it('always populates the temporal labels — interval, max_ma, min_ma', () => {
    const b = normalizeDiversityBin({ interval_name: 'Jurassic', max_ma: 201.4, min_ma: 143.1 });
    expect(b.interval).toBe('Jurassic');
    expect(b.max_ma).toBe(201.4);
    expect(b.min_ma).toBe(143.1);
  });

  it('rejects a bin missing its interval name or Ma boundaries (unusable record)', () => {
    // These are required outputs — PBDB labels every bin, so a record without them
    // is unusable. Fail loud rather than emit a temporally anonymous bin.
    expect(() => normalizeDiversityBin({ max_ma: 143.1, min_ma: 66 })).toThrow(
      /interval name or Ma boundaries/,
    );
    expect(() => normalizeDiversityBin({ interval_name: 'Cretaceous', min_ma: 66 })).toThrow();
    expect(() => normalizeDiversityBin({ interval_name: 'Cretaceous', max_ma: 143.1 })).toThrow();
  });
});

describe('normalizeCollection', () => {
  it('strips PBDB quote-wrapping from lithology and environment', () => {
    const raw: PbdbCollectionRecord = {
      collection_no: '11917',
      collection_name: "Knudsen's Coulee",
      lng: -113.0289,
      lat: 51.906399,
      early_interval: 'Late Maastrichtian',
      max_ma: 72.2,
      min_ma: 66,
      formation: 'Scollard',
      lithology1: 'sandstone',
      lithdescript: '"concretionary zone in the basal part of a channel sandstone"',
      environment: '"channel"',
      n_occs: '1',
    };
    const c = normalizeCollection(raw);
    expect(c.collection_no).toBe(11917);
    expect(c.lithology).toBe('sandstone');
    expect(c.lithology_description).toBe(
      'concretionary zone in the basal part of a channel sandstone',
    );
    expect(c.environment).toBe('channel');
    expect(c.n_occs).toBe(1);
  });

  it('omits lithology/environment entirely on a sparse locality', () => {
    const raw: PbdbCollectionRecord = {
      collection_no: '200',
      lng: 10,
      lat: 20,
      early_interval: 'Jurassic',
    };
    const c = normalizeCollection(raw);
    expect(c).not.toHaveProperty('lithology');
    expect(c).not.toHaveProperty('environment');
    expect(c).not.toHaveProperty('formation');
  });
});

describe('normalizeInterval', () => {
  const scaleNames = new Map([
    [1, 'International Chronostratigraphic Timescale'],
    [12, 'Mesozoic Subages'],
    [100, 'Cretaceous North American Land-Mammal Ages'],
  ]);

  it('maps b_age/t_age to max_ma/min_ma and labels the scale', () => {
    // PBDB interval 654, as `intervals/list?name=Late Maastrichtian` returns it.
    const raw: PbdbIntervalRecord = {
      interval_no: '654',
      scale_no: '12',
      interval_name: 'Late Maastrichtian',
      type: 'subage',
      t_age: 66,
      b_age: 72.2,
      reference_no: '9098',
    };
    expect(normalizeInterval(raw, scaleNames)).toEqual({
      interval_no: 654,
      name: 'Late Maastrichtian',
      level: 'subage',
      max_ma: 72.2,
      min_ma: 66,
      scale: 'Mesozoic Subages',
    });
  });

  it('carries parent_no and color when the scale defines them', () => {
    const raw: PbdbIntervalRecord = {
      interval_no: '112',
      scale_no: '1',
      interval_name: 'Maastrichtian',
      type: 'age',
      parent_no: '39',
      color: '#F2FA8C',
      t_age: 66,
      b_age: 72.2,
    };
    const iv = normalizeInterval(raw, scaleNames);
    expect(iv.parent_no).toBe(39);
    expect(iv.color).toBe('#F2FA8C');
    expect(iv.scale).toBe('International Chronostratigraphic Timescale');
  });

  it('omits the scale label when the scale_no is not in the directory', () => {
    const raw: PbdbIntervalRecord = {
      interval_no: '9999',
      scale_no: '4242',
      interval_name: 'Newscalian',
      type: 'zone',
      t_age: 5,
      b_age: 9,
    };
    const iv = normalizeInterval(raw, scaleNames);
    expect(iv).not.toHaveProperty('scale');
    expect(iv.level).toBe('zone');
  });

  it('keeps a zero t_age rather than dropping the younger boundary', () => {
    const raw: PbdbIntervalRecord = {
      interval_no: '32',
      scale_no: '1',
      interval_name: 'Holocene',
      type: 'epoch',
      t_age: 0,
      b_age: 0.0117,
    };
    expect(normalizeInterval(raw, scaleNames).min_ma).toBe(0);
  });

  it('rejects an interval missing a Ma boundary rather than emitting a half-range', () => {
    const raw: PbdbIntervalRecord = {
      interval_no: '654',
      scale_no: '12',
      interval_name: 'Late Maastrichtian',
      type: 'subage',
      t_age: 66,
    };
    expect(() => normalizeInterval(raw, scaleNames)).toThrow(/Ma boundaries/);
  });
});
