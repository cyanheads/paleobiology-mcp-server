/**
 * @fileoverview In-memory index over the bundled ICS geologic time scale.
 *
 * Backs the offline half of `paleobiology_list_intervals`: browsing the scale and
 * every name the ICS international scale carries resolves here with no network
 * call. Names outside it — PBDB's sub-stage and regional scales — are resolved
 * upstream by the tool handler, which owns that fallback so this stays a plain
 * synchronous index. The set is small and bounded (~171 intervals) — not a
 * MirrorService or DataCanvas. Built once at startup via {@link initIntervalIndex}.
 * @module services/intervals/interval-index
 */

import type { Interval, IntervalLevel } from '../pbdb/types.js';
import { ICS_INTERVALS, ICS_VERSION, SNAPSHOT_GENERATED } from './time-scale-data.js';

/** Normalize an interval name for case-insensitive lookup. */
const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Oldest-first comparator (descending `max_ma`). Ties — a period and its older
 * epoch share a bottom boundary — keep snapshot order, which nests the coarser
 * interval ahead of its children.
 */
const oldestFirst = (a: Interval, b: Interval): number => b.max_ma - a.max_ma;

/** The filters `paleobiology_list_intervals` narrows the time scale by. */
export interface IntervalFilters {
  level?: IntervalLevel;
  maxMa?: number;
  minMa?: number;
  name?: string;
}

/**
 * Apply the list tool's filters to any interval set, sorted oldest-first. All
 * filters are ANDed; substring match on `name`, inclusive Ma overlap for the
 * range, exact `level`.
 *
 * Module-level rather than a method so the same predicate and ordering apply to
 * an interval resolved upstream, which never enters the bundled index.
 */
export function filterIntervals(intervals: readonly Interval[], opts: IntervalFilters): Interval[] {
  const needle = opts.name ? norm(opts.name) : undefined;
  return intervals
    .filter((iv) => {
      if (needle && !norm(iv.name).includes(needle)) return false;
      if (opts.level && iv.level !== opts.level) return false;
      // Overlap test against [minMa, maxMa] when either bound is supplied.
      if (opts.minMa != null && iv.max_ma < opts.minMa) return false;
      if (opts.maxMa != null && iv.min_ma > opts.maxMa) return false;
      return true;
    })
    .sort(oldestFirst);
}

export class IntervalIndex {
  private readonly byNameExact = new Map<string, Interval>();
  private readonly intervals: readonly Interval[];

  constructor(intervals: readonly Interval[]) {
    this.intervals = intervals;
    for (const iv of intervals) {
      this.byNameExact.set(norm(iv.name), iv);
    }
  }

  /** The snapshot version string surfaced to consumers (`ICS_VERSION (generated …)`). */
  get snapshotVersion(): string {
    return `ICS ${ICS_VERSION} (snapshot generated ${SNAPSHOT_GENERATED})`;
  }

  /** Exact (case-insensitive) interval lookup by name. */
  byName(name: string): Interval | undefined {
    return this.byNameExact.get(norm(name));
  }

  /**
   * Filter the bundled intervals for the list tool. Sorted oldest-first, same as
   * {@link all} — the bundled snapshot is in hierarchical eon→age traversal order
   * (roughly youngest-first), so returning raw array order here would contradict
   * the schema's oldest-first contract.
   */
  filter(opts: IntervalFilters): Interval[] {
    return filterIntervals(this.intervals, opts);
  }

  /** All intervals, optionally restricted to one level. Sorted oldest-first. */
  all(level?: IntervalLevel): Interval[] {
    const items = level ? this.intervals.filter((iv) => iv.level === level) : [...this.intervals];
    return items.sort(oldestFirst);
  }
}

let _index: IntervalIndex | undefined;

/** Build the singleton index from the bundled snapshot. Call in setup(). */
export function initIntervalIndex(): void {
  _index = new IntervalIndex(ICS_INTERVALS);
}

/** Resolve the index; throws if not initialized. */
export function getIntervalIndex(): IntervalIndex {
  if (!_index) {
    throw new Error('IntervalIndex not initialized — call initIntervalIndex() in setup()');
  }
  return _index;
}
