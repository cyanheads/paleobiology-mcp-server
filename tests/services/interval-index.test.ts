/**
 * @fileoverview Tests for the bundled-snapshot IntervalIndex — name lookup, Ma
 * overlap, level filtering, and the snapshot version string.
 * @module tests/services/interval-index
 */

import { describe, expect, it } from 'vitest';
import { IntervalIndex } from '@/services/intervals/interval-index.js';
import { ICS_INTERVALS } from '@/services/intervals/time-scale-data.js';

const index = new IntervalIndex(ICS_INTERVALS);

describe('IntervalIndex', () => {
  it('bundles the ICS scale with every level present', () => {
    const levels = new Set(index.all().map((iv) => iv.level));
    expect(levels).toEqual(new Set(['eon', 'era', 'period', 'epoch', 'age']));
    expect(index.all().length).toBeGreaterThan(150);
  });

  it('resolves a named interval case-insensitively to its Ma boundaries', () => {
    const m = index.byName('maastrichtian');
    expect(m).toBeDefined();
    expect(m?.name).toBe('Maastrichtian');
    expect(m?.level).toBe('age');
    expect(m?.max_ma).toBe(72.2);
    expect(m?.min_ma).toBe(66);
  });

  it('filters by name substring, oldest-first', () => {
    const hits = index.filter({ name: 'cretaceous' });
    // The Early Cretaceous shares the period's 143.1 Ma bottom boundary, so the
    // containing period leads; the Late Cretaceous (100.5 Ma) comes last.
    expect(hits.map((iv) => iv.name)).toEqual([
      'Cretaceous',
      'Early Cretaceous',
      'Late Cretaceous',
    ]);
  });

  it('filters by Ma overlap', () => {
    // 70 Ma falls inside the Maastrichtian (66–72.2) and Late Cretaceous (66–100.5).
    const hits = index.filter({ minMa: 70, maxMa: 70, level: 'age' });
    expect(hits.map((iv) => iv.name)).toContain('Maastrichtian');
  });

  it('returns FILTERED intervals oldest-first, not raw snapshot order', () => {
    // The snapshot is a hierarchical eon→age traversal that runs roughly
    // youngest-first; the schema, format(), and all() all promise oldest-first,
    // so filter() must sort too rather than leak the traversal order.
    const periods = index.filter({ level: 'period' });
    expect(periods.length).toBeGreaterThan(10);
    expect(periods[0]?.name).toBe('Siderian');
    expect(periods.at(-1)?.name).toBe('Quaternary');
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i - 1]!.max_ma).toBeGreaterThanOrEqual(periods[i]!.max_ma);
    }
  });

  it('restricts to a single level', () => {
    const periods = index.all('period');
    expect(periods.every((iv) => iv.level === 'period')).toBe(true);
    expect(periods.map((iv) => iv.name)).toContain('Cretaceous');
    expect(periods.map((iv) => iv.name)).not.toContain('Maastrichtian');
  });

  it('returns intervals oldest-first', () => {
    const all = index.all();
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.max_ma).toBeGreaterThanOrEqual(all[i]!.max_ma);
    }
  });

  it('exposes a citable snapshot version', () => {
    expect(index.snapshotVersion).toMatch(/^ICS .+snapshot generated/);
  });
});
