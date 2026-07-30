/**
 * @fileoverview Paleobiology Database (PBDB) HTTP client + normalizer.
 *
 * One method per resource family. Every request carries `vocab=pbdb` (so PBDB
 * emits readable field names) plus the per-tool `show` blocks each tool needs;
 * raw compact codes never reach the agent. Retry wraps the full fetch+parse
 * pipeline (degraded-upstream backoff). The normalizer coerces PBDB's mixed
 * string/number fields, computes the few derived fields (FAD/LAD windows,
 * origination/extinction sums from the diversity boundary-crosser counts), and
 * preserves absence as "unknown" — never defaulting sparse fields to 0/''.
 *
 * Design decisions grounded against the live API (paleobiodb.org/data1.2):
 *  - `environment: 'freshwater'` has no single PBDB `envtype`; it maps to the
 *    two freshwater macro-zones `lacustrine,fluvial`. `marine`/`terrestrial` are
 *    direct macro-zones.
 *  - `resolution: 'age'` maps to PBDB `time_reso=stage` (PBDB's token for the
 *    stage/age level); `period`/`epoch` pass through.
 *  - A not-found lookup returns HTTP 404 (unknown id, and an unmatched taxon
 *    name) or — on `taxa/single` only — HTTP 400 for a name that isn't a valid
 *    scientific name, each with an `errors[]` body. Both are reclassified to a
 *    clean NotFound in {@link sanitizeUpstreamError}; some 200+`errors[]` cases
 *    are caught in {@link parseEnvelope}. All surface as the caller's typed
 *    not-found. Every other endpoint reserves HTTP 400 + `errors[]` for a
 *    malformed PARAMETER, which surfaces as `InvalidParams` carrying PBDB's own
 *    rejection text. Every other upstream failure (403/429/5xx/timeout/network)
 *    is also routed through {@link sanitizeUpstreamError}, which strips the raw
 *    upstream plumbing (statusCode/responseBody/requestId/URL) the framework
 *    would otherwise forward to the client, re-minting a same-code error with
 *    leak-free `data`.
 *  - PBDB reports a filter value it did not understand in `warnings[]` while
 *    still answering HTTP 200 — and for `lithology` it answers with the FULL
 *    UNFILTERED set. So warnings are carried out alongside the records rather
 *    than dropped: without them an ignored filter is indistinguishable from a
 *    real match, and an unmatched taxon name from a genuinely empty query.
 *  - The list searches send `rowcount`, which adds `records_found` (the true
 *    match count, independent of limit/offset) to the envelope at the cost of an
 *    upstream COUNT pass. It turns truncation from a full-page inference into a
 *    known fact and lets the tools state the exact remainder.
 *  - `taxa/list` is the exception: there `records_found` is min(limit, true_total)
 *    — always equal to the rows just returned — so `rowcount` cannot disclose a
 *    truncated child list. Measured against a taxon with 1,077 immediate children:
 *    200 at limit=200, 500 at limit=500, 1076 at limit=1076. Only a `limit=0`
 *    preflight yields the real total, and that doubles the upstream calls on every
 *    `show_children` request. The child pull therefore over-fetches ONE row and
 *    reports a boolean `children_truncated` instead — same request count, honest
 *    disclosure, and the caller pages with `childrenOffset` rather than needing an
 *    exact count.
 *  - `intervals/list` answers an unknown interval name with HTTP 200, an empty
 *    `records[]`, and a `warnings[]` note — not a 404 — so a name miss is read off
 *    the record count rather than off a thrown error, and needs no
 *    `expectedStatuses` entry. Its records carry `scale_no` but no scale name;
 *    that directory is a separate `timescales/list` call, cached per process.
 * @module services/pbdb/pbdb-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '../../config/server-config.js';
import type {
  Collection,
  CollectionFilter,
  CollectionResult,
  DiversityBin,
  DiversityFilter,
  DiversityResult,
  EnvironmentFilter,
  Interval,
  Occurrence,
  OccurrenceFilter,
  OccurrenceSearch,
  PbdbCollectionRecord,
  PbdbDiversityRecord,
  PbdbEnvelope,
  PbdbIntervalRecord,
  PbdbOccurrenceRecord,
  PbdbResponse,
  PbdbSearchMeta,
  PbdbTaxonRecord,
  PbdbTimescaleRecord,
  Taxon,
  TaxonClassification,
  TaxonLookup,
  TaxonStub,
} from './types.js';

/** PBDB `show` blocks per endpoint, grounded against the live API. */
const SHOW_BLOCKS = {
  occurrences: 'coords,loc,strat,class,paleoloc',
  taxa: 'class,app,size,parent',
  collections: 'loc,strat,lith,env,time',
} as const;

/**
 * Immediate children returned per `getTaxon` call. PBDB's `taxa/list` has no
 * usable total for this relation, so the page is fixed and callers walk it with
 * `childrenOffset`.
 */
export const TAXON_CHILDREN_PAGE_SIZE = 200;

/** Map the agent-facing environment enum to PBDB `envtype` values. */
function envtypeFor(env: EnvironmentFilter): string {
  switch (env) {
    case 'freshwater':
      return 'lacustrine,fluvial';
    default:
      return env; // 'marine' | 'terrestrial' are direct macro-zones
  }
}

/**
 * Render a clade-inclusive taxon id as PBDB's prefixed `base_id` value, or
 * `undefined` when the caller filtered by name instead. PBDB rejects `base_name`
 * and `base_id` together with HTTP 400; each tool guards the pair at its boundary
 * so the agent gets a typed reason rather than the passed-through rejection.
 */
function baseIdParam(baseId: number | undefined): string | undefined {
  return baseId != null ? `txn:${baseId}` : undefined;
}

/** Map the agent-facing resolution enum to PBDB `time_reso` values. */
function timeResoFor(resolution: DiversityFilter['resolution']): string {
  return resolution === 'age' ? 'stage' : resolution;
}

/** Coerce PBDB's mixed string/number numeric fields to a number, or undefined. */
function num(v: number | string | undefined | null): number | undefined {
  if (v == null || v === '') return;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a PBDB integer-id string to a number, or undefined. */
function intId(v: string | number | undefined): number | undefined {
  return num(v);
}

/** Build a classification object from the `class` block, dropping absent levels. */
function classificationOf(r: {
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
}): TaxonClassification {
  const c: TaxonClassification = {};
  if (r.phylum) c.phylum = r.phylum;
  if (r.class) c.class = r.class;
  // PBDB uses the literal "NO_ORDER_SPECIFIED" as a sentinel — treat as absent.
  if (r.order && r.order !== 'NO_ORDER_SPECIFIED') c.order = r.order;
  if (r.family) c.family = r.family;
  if (r.genus) c.genus = r.genus;
  return c;
}

export class PbdbService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** Lazily-filled `scale_no` → scale-name directory. See {@link PbdbService.timeScaleNames}. */
  private scaleNames?: ReadonlyMap<number, string>;

  constructor(_config: AppConfig) {
    const cfg = getServerConfig();
    this.baseUrl = cfg.pbdbBaseUrl.replace(/\/$/, '');
    this.timeoutMs = cfg.pbdbTimeoutMs;
  }

  // ── Request plumbing ───────────────────────────────────────────────────────

  /**
   * Issue a GET against a PBDB endpoint, with retry + timeout. Returns the parsed
   * records plus the envelope metadata riding alongside them (warnings, row counts).
   *
   * `expectedStatuses` lists the non-2xx statuses that are an ordinary outcome for
   * this endpoint rather than a fault — a single-record lookup answering "no such
   * record" with a 404. The framework logs those at `debug` instead of `error`
   * (the thrown, status-mapped McpError is unchanged), so an empty result stops
   * producing error-level noise.
   */
  private get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    operation: string,
    expectedStatuses: number[] = [],
  ): Promise<PbdbResponse<T>> {
    const url = new URL(`${this.baseUrl}/${path}.json`);
    url.searchParams.set('vocab', 'pbdb');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });

    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            signal: ctx.signal,
            expectedStatuses,
          });
        } catch (err) {
          // fetchWithTimeout throws a status-mapped McpError on every non-2xx, plus
          // a Timeout/ServiceUnavailable/InternalError on timeout / network / abort.
          // Each of those carries the raw upstream plumbing in `data` (statusCode,
          // statusText, responseBody, requestId, operation) and the fetched URL in
          // its message — all of which the framework forwards verbatim to the client
          // on a public server. Sanitize EVERY upstream McpError into a clean typed
          // domain error (PBDB's 400/404 not-found → NotFound the tool can remap;
          // everything else → same code, leak-free `data`, original kept as `cause`),
          // so nothing internal escapes. Transient codes are preserved, so withRetry
          // still backs off on 5xx / rate-limit / timeout.
          throw sanitizeUpstreamError(err, operation);
        }
        const text = await response.text();
        return this.parseEnvelope<T>(text, operation);
      },
      {
        operation,
        context: reqCtx,
        baseDelayMs: 1500, // PBDB is a research DB; degraded-upstream backoff
        signal: ctx.signal,
      },
    );
  }

  /**
   * Parse a PBDB JSON envelope. PBDB also returns HTTP 200 with an `errors[]`
   * array for some not-found lookups — surface those as NotFound the caller can
   * reclassify. An HTML body means an upstream hiccup (transient).
   *
   * `errors[]` arrives INSTEAD of a result; `warnings[]` arrives ALONGSIDE one and
   * is carried out on {@link PbdbSearchMeta} rather than raised — the call
   * succeeded, PBDB just ignored part of the query.
   */
  private parseEnvelope<T>(text: string, operation: string): PbdbResponse<T> {
    if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        `PBDB returned HTML instead of JSON during ${operation} — likely a transient upstream issue.`,
      );
    }
    let body: PbdbEnvelope<T>;
    try {
      body = JSON.parse(text) as PbdbEnvelope<T>;
    } catch (err) {
      throw serviceUnavailable(
        `PBDB returned an unparseable response during ${operation}.`,
        undefined,
        {
          cause: err,
        },
      );
    }
    if (body.errors && body.errors.length > 0 && (!body.records || body.records.length === 0)) {
      // Caller-level "not found" — message carries PBDB's own text.
      throw notFound(body.errors.join('; '), { reason: 'pbdb_not_found' });
    }
    const meta: PbdbSearchMeta = {};
    if (body.warnings && body.warnings.length > 0) meta.warnings = body.warnings;
    if (typeof body.records_found === 'number') meta.recordsFound = body.records_found;
    if (typeof body.records_returned === 'number') meta.recordsReturned = body.records_returned;
    return { records: body.records ?? [], meta };
  }

  // ── Occurrences ─────────────────────────────────────────────────────────────

  /**
   * Search fossil occurrences. Returns a {@link OccurrenceSearch} handle: an async
   * generator the spillover helper streams rows from, plus the `meta` object the
   * generator fills in from the upstream envelope before yielding its first row.
   *
   * The handle exists because neither drain path can see a generator's return
   * value — `spillover()` discards `next.value` once `next.done` is set, and a
   * `for await` loop does the same — so the true match count and PBDB's warnings
   * need a channel the caller still holds after the stream is exhausted.
   */
  searchOccurrences(filter: OccurrenceFilter, ctx: Context): OccurrenceSearch {
    const cap = Math.min(filter.limit, getServerConfig().pbdbMaxOccurrences);
    const params: Record<string, string | number | undefined> = {
      show: SHOW_BLOCKS.occurrences,
      limit: cap,
      offset: filter.offset,
      // Ask PBDB for the true match count so the caller can state the exact
      // remainder instead of inferring truncation from a full page. It is
      // independent of `offset`, so the same total anchors every page.
      rowcount: 1,
      base_name: filter.baseName,
      base_id: baseIdParam(filter.baseId),
      taxon_name: filter.taxonName,
      coll_id: filter.collectionNo,
      interval: filter.interval,
      max_ma: filter.maxMa,
      min_ma: filter.minMa,
      lngmin: filter.lngmin,
      lngmax: filter.lngmax,
      latmin: filter.latmin,
      latmax: filter.latmax,
      envtype: filter.environment ? envtypeFor(filter.environment) : undefined,
    };
    const meta: PbdbSearchMeta = {};
    const self = this;
    async function* rows(): AsyncGenerator<Occurrence> {
      const response = await self.get<PbdbOccurrenceRecord>(
        'occs/list',
        params,
        ctx,
        'searchOccurrences',
      );
      Object.assign(meta, response.meta);
      for (const r of response.records) yield normalizeOccurrence(r);
    }
    return { rows: rows(), meta };
  }

  /** Fetch one occurrence by its integer id. */
  async getOccurrence(occurrenceNo: number, ctx: Context): Promise<Occurrence> {
    const { records } = await this.get<PbdbOccurrenceRecord>(
      'occs/single',
      { id: `occ:${occurrenceNo}`, show: SHOW_BLOCKS.occurrences },
      ctx,
      'getOccurrence',
      // An unknown occurrence_no is an ordinary empty result, not a fault.
      [404],
    );
    const rec = records[0];
    if (!rec) {
      throw notFound(`No PBDB occurrence with occurrence_no ${occurrenceNo}.`, {
        reason: 'occurrence_not_found',
        occurrence_no: occurrenceNo,
      });
    }
    return normalizeOccurrence(rec);
  }

  // ── Taxa ────────────────────────────────────────────────────────────────────

  /**
   * Resolve a taxon by name or integer id; optionally include one page of
   * immediate children ({@link TAXON_CHILDREN_PAGE_SIZE} rows from
   * `args.childrenOffset`), with `children_truncated` set when more remain.
   */
  async getTaxon(args: TaxonLookup, ctx: Context): Promise<Taxon> {
    const idParam = args.taxonNo != null ? `txn:${args.taxonNo}` : undefined;
    const { records } = await this.get<PbdbTaxonRecord>(
      'taxa/single',
      { name: args.name, id: idParam, show: SHOW_BLOCKS.taxa },
      ctx,
      'getTaxon',
      // `taxa/single` answers an unknown id or unmatched name with 404 and a name
      // that isn't a valid scientific name with 400 — both ordinary "no match".
      [400, 404],
    );
    const rec = records[0];
    if (!rec) {
      throw notFound(
        args.name != null
          ? `No PBDB taxon matched the name "${args.name}".`
          : `No PBDB taxon with taxon_no ${args.taxonNo}.`,
        { reason: 'taxon_not_found' },
      );
    }
    const taxon = normalizeTaxon(rec);

    if (args.showChildren) {
      const offset = args.childrenOffset ?? 0;
      // Over-fetch by one row to learn whether another page exists. `rowcount`
      // cannot answer that here: on `taxa/list` PBDB reports `records_found` as
      // min(limit, true_total) — always equal to what it just returned — so the
      // only exact total comes from a second `limit=0` preflight. Asking for one
      // extra row instead keeps this to a single request; the sentinel row is
      // dropped before the page is handed back.
      const { records: childRecords } = await this.get<PbdbTaxonRecord>(
        'taxa/list',
        {
          id: `txn:${taxon.taxon_no}`,
          rel: 'children',
          show: 'app',
          limit: TAXON_CHILDREN_PAGE_SIZE + 1,
          offset,
        },
        ctx,
        'getTaxonChildren',
      );
      taxon.children = childRecords
        .filter((c) => intId(c.taxon_no) !== taxon.taxon_no)
        .slice(0, TAXON_CHILDREN_PAGE_SIZE)
        .map(normalizeTaxonStub);
      taxon.children_offset = offset;
      // Count the RAW rows, not the filtered stubs — the self-exclusion above
      // could otherwise mask a full page as a short one.
      taxon.children_truncated = childRecords.length > TAXON_CHILDREN_PAGE_SIZE;
    }
    return taxon;
  }

  // ── Diversity ────────────────────────────────────────────────────────────────

  /**
   * Compute a diversity / origination / extinction curve, binned by interval.
   *
   * No `rowcount` here — a diversity response's row count is its bin count, which
   * is already the whole curve; the metadata that matters is `warnings`, which is
   * how an unmatched `base_name` reads differently from a clade with no data in
   * the span (both return zero bins).
   */
  async getDiversity(filter: DiversityFilter, ctx: Context): Promise<DiversityResult> {
    const { records, meta } = await this.get<PbdbDiversityRecord>(
      'occs/diversity',
      {
        base_name: filter.baseName,
        base_id: baseIdParam(filter.baseId),
        count: filter.count,
        time_reso: timeResoFor(filter.resolution),
        interval: filter.interval,
        max_ma: filter.maxMa,
        min_ma: filter.minMa,
      },
      ctx,
      'getDiversity',
    );
    const bins = records.map(normalizeDiversityBin);
    return meta.warnings ? { bins, warnings: meta.warnings } : { bins };
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  /** Search fossil collections (localities), paged inline. */
  async searchCollections(filter: CollectionFilter, ctx: Context): Promise<CollectionResult> {
    const cap = Math.min(filter.limit, getServerConfig().pbdbMaxOccurrences);
    const params: Record<string, string | number | undefined> = {
      show: SHOW_BLOCKS.collections,
      limit: cap,
      offset: filter.offset,
      // Ask PBDB for the true match count so truncation is known, not inferred
      // from a full page (a final page that exactly fills `limit` is not truncated).
      rowcount: 1,
      base_name: filter.baseName,
      base_id: baseIdParam(filter.baseId),
      interval: filter.interval,
      max_ma: filter.maxMa,
      min_ma: filter.minMa,
      lngmin: filter.lngmin,
      lngmax: filter.lngmax,
      latmin: filter.latmin,
      latmax: filter.latmax,
      formation: filter.formation,
      lithology: filter.lithology,
      envtype: filter.environment ? envtypeFor(filter.environment) : undefined,
    };
    const { records, meta } = await this.get<PbdbCollectionRecord>(
      'colls/list',
      params,
      ctx,
      'searchCollections',
    );
    const collections = records.map(normalizeCollection);
    const shown = collections.length;
    const result: CollectionResult = {
      collections,
      shown,
      offset: filter.offset,
      // With the true total known, truncation is a fact: records remain only when
      // this page ends before the total. Without it (PBDB omitted `records_found`),
      // fall back to the page-filled heuristic, which over-reports a final full page.
      truncated:
        meta.recordsFound != null ? filter.offset + shown < meta.recordsFound : shown >= cap,
      cap,
    };
    if (meta.recordsFound != null) result.total = meta.recordsFound;
    if (meta.warnings) result.warnings = meta.warnings;
    return result;
  }

  // ── Intervals ────────────────────────────────────────────────────────────────

  /**
   * Resolve one interval by exact name across every PBDB time scale — the
   * sub-stage and regional names (`Late Maastrichtian`, `Lancian`) that occurrence
   * and collection rows report but the bundled ICS snapshot does not carry.
   *
   * `undefined` means PBDB has no interval by that name. Unlike the single-record
   * endpoints, `intervals/list` answers an unknown name with HTTP 200 + an empty
   * `records[]` and a `warnings[]` note, so a miss never reaches
   * {@link sanitizeUpstreamError} and needs no `expectedStatuses` entry. The match
   * is exact (case-insensitive) and returns at most one record even for a name
   * carried by several scales.
   *
   * The scale name comes from a second endpoint — `intervals/list` emits only
   * `scale_no`, and a bare number does not tell an agent it is off the
   * international scale. The 65-row directory is fetched once per process and
   * cached (scale names change on the order of never), and rides along in the
   * same `Promise.all` so a first lookup costs one round trip, not two.
   */
  async lookupInterval(name: string, ctx: Context): Promise<Interval | undefined> {
    const [{ records }, scaleNames] = await Promise.all([
      this.get<PbdbIntervalRecord>('intervals/list', { name }, ctx, 'lookupInterval'),
      this.timeScaleNames(ctx),
    ]);
    const rec = records[0];
    return rec ? normalizeInterval(rec, scaleNames) : undefined;
  }

  /** The `scale_no` → scale-name directory, fetched once per process. */
  private async timeScaleNames(ctx: Context): Promise<ReadonlyMap<number, string>> {
    if (this.scaleNames) return this.scaleNames;
    const { records } = await this.get<PbdbTimescaleRecord>(
      'timescales/list',
      { all_records: 1 },
      ctx,
      'listTimeScales',
    );
    const names = new Map<number, string>();
    for (const r of records) {
      const no = intId(r.scale_no);
      if (no != null && r.scale_name) names.set(no, r.scale_name);
    }
    // Only a successful fetch is cached — a failed one must not pin an empty map.
    this.scaleNames = names;
    return names;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a raw occurrence record, preserving absence. */
export function normalizeOccurrence(r: PbdbOccurrenceRecord): Occurrence {
  const classification = classificationOf(r);
  const o: Occurrence = { occurrence_no: intId(r.occurrence_no) ?? 0 };
  const collectionNo = intId(r.collection_no);
  if (collectionNo != null) o.collection_no = collectionNo;
  if (r.identified_name) o.identified_name = r.identified_name;
  if (r.identified_rank) o.identified_rank = r.identified_rank;
  if (r.accepted_name) o.accepted_name = r.accepted_name;
  if (r.accepted_rank) o.accepted_rank = r.accepted_rank;
  const acceptedNo = intId(r.accepted_no);
  if (acceptedNo != null) o.accepted_no = acceptedNo;
  if (r.early_interval) o.early_interval = r.early_interval;
  if (r.late_interval) o.late_interval = r.late_interval;
  const maxMa = num(r.max_ma);
  if (maxMa != null) o.max_ma = maxMa;
  const minMa = num(r.min_ma);
  if (minMa != null) o.min_ma = minMa;
  const lng = num(r.lng);
  if (lng != null) o.lng = lng;
  const lat = num(r.lat);
  if (lat != null) o.lat = lat;
  const paleolng = num(r.paleolng);
  if (paleolng != null) o.paleolng = paleolng;
  const paleolat = num(r.paleolat);
  if (paleolat != null) o.paleolat = paleolat;
  if (r.paleomodel) o.paleomodel = r.paleomodel;
  if (r.geoplate) o.geoplate = r.geoplate;
  if (r.formation) o.formation = r.formation;
  if (r.geological_group) o.geological_group = r.geological_group;
  if (r.member) o.member = r.member;
  if (r.cc) o.cc = r.cc;
  if (r.state) o.state = r.state;
  if (r.county) o.county = r.county;
  if (Object.keys(classification).length > 0) o.classification = classification;
  const refNo = intId(r.reference_no);
  if (refNo != null) o.reference_no = refNo;
  return o;
}

/** Normalize a raw taxon record into a full Taxon (range + classification). */
export function normalizeTaxon(r: PbdbTaxonRecord): Taxon {
  const t: Taxon = {
    taxon_no: intId(r.taxon_no) ?? 0,
    classification: classificationOf(r),
    extant: r.is_extant === 'extant',
    range: {
      first_appearance: appearanceWindow(r.firstapp_max_ma, r.firstapp_min_ma, r.early_interval),
      last_appearance: appearanceWindow(r.lastapp_max_ma, r.lastapp_min_ma, r.late_interval),
    },
  };
  if (r.accepted_name) t.accepted_name = r.accepted_name;
  // PBDB populates `taxon_rank` on a by-name lookup but leaves it null on a
  // by-id lookup, where the rank lives in `accepted_rank` — fall back to it so
  // get_taxon by taxon_no and the taxon resource surface the rank either way.
  const rank = r.taxon_rank || r.accepted_rank;
  if (rank) t.rank = rank;
  const parentNo = intId(r.parent_no);
  if (parentNo != null) t.parent_no = parentNo;
  if (r.parent_name) t.parent_name = r.parent_name;
  const occCount = num(r.n_occs);
  if (occCount != null) t.occurrence_count = occCount;
  return t;
}

/** Build a FAD/LAD window, dropping it to empty when no data. */
function appearanceWindow(
  maxMa: number | undefined,
  minMa: number | undefined,
  interval: string | undefined,
): Taxon['range']['first_appearance'] {
  const w: Taxon['range']['first_appearance'] = {};
  const mx = num(maxMa);
  if (mx != null) w.max_ma = mx;
  const mn = num(minMa);
  if (mn != null) w.min_ma = mn;
  if (interval) w.interval = interval;
  return w;
}

/** Normalize a child-taxon stub from a `taxa/list` row. */
export function normalizeTaxonStub(r: PbdbTaxonRecord): TaxonStub {
  const s: TaxonStub = { taxon_no: intId(r.taxon_no) ?? 0 };
  if (r.taxon_name) s.name = r.taxon_name;
  if (r.accepted_rank) s.rank = r.accepted_rank;
  const occCount = num(r.n_occs);
  if (occCount != null) s.occurrence_count = occCount;
  // PBDB flags synonyms via `difference` + an accepted_name that differs from the row name.
  if (r.difference && r.accepted_name && r.accepted_name !== r.taxon_name) {
    s.synonym_of = r.accepted_name;
  }
  return s;
}

/**
 * Normalize a diversity bin. Originations = first-occurrence-in-bin taxa
 * (`X_Ft` survivors + `X_FL` singletons); extinctions = last-occurrence-in-bin
 * taxa (`X_bL` enterers + `X_FL` singletons). This is the standard PBDB
 * boundary-crosser → origination/extinction computation.
 */
export function normalizeDiversityBin(r: PbdbDiversityRecord): DiversityBin {
  const xFt = num(r.X_Ft) ?? 0;
  const xBl = num(r.X_bL) ?? 0;
  const xFl = num(r.X_FL) ?? 0;
  const xBt = num(r.X_bt) ?? 0;
  const interval = r.interval_name;
  const maxMa = num(r.max_ma);
  const minMa = num(r.min_ma);
  // PBDB labels every diversity bin with its interval name and Ma boundaries; a
  // bin missing any of them is an unusable record — fail loud rather than emit a
  // temporally-anonymous bin the output schema now declares always present.
  if (!interval || maxMa == null || minMa == null) {
    throw serviceUnavailable(
      'PBDB returned a diversity bin without its interval name or Ma boundaries.',
    );
  }
  return {
    interval,
    max_ma: maxMa,
    min_ma: minMa,
    sampled_in_bin: num(r.sampled_in_bin) ?? 0,
    implied: num(r.implied_in_bin) ?? 0,
    originations: xFt + xFl,
    extinctions: xBl + xFl,
    range_through: xBt,
    n_occurrences: num(r.n_occs) ?? 0,
  };
}

/**
 * Normalize a raw interval record. PBDB's `b_age`/`t_age` are the older/younger
 * boundaries and map to the domain's `max_ma`/`min_ma`. A record missing its id,
 * name, rank, or either boundary is unusable — the whole point of the lookup is
 * the name↔Ma translation — so it fails loud rather than emit a half-interval.
 */
export function normalizeInterval(
  r: PbdbIntervalRecord,
  scaleNames: ReadonlyMap<number, string>,
): Interval {
  const intervalNo = intId(r.interval_no);
  const maxMa = num(r.b_age);
  const minMa = num(r.t_age);
  if (intervalNo == null || !r.interval_name || !r.type || maxMa == null || minMa == null) {
    throw serviceUnavailable(
      'PBDB returned an interval without its id, name, rank, or Ma boundaries.',
    );
  }
  const iv: Interval = {
    interval_no: intervalNo,
    name: r.interval_name,
    level: r.type,
    max_ma: maxMa,
    min_ma: minMa,
  };
  const parentNo = intId(r.parent_no);
  if (parentNo != null) iv.parent_no = parentNo;
  if (r.color) iv.color = r.color;
  const scaleNo = intId(r.scale_no);
  const scale = scaleNo != null ? scaleNames.get(scaleNo) : undefined;
  if (scale) iv.scale = scale;
  return iv;
}

/** Normalize a raw collection record, preserving absence. */
export function normalizeCollection(r: PbdbCollectionRecord): Collection {
  const c: Collection = { collection_no: intId(r.collection_no) ?? 0 };
  if (r.collection_name) c.collection_name = r.collection_name;
  const lng = num(r.lng);
  if (lng != null) c.lng = lng;
  const lat = num(r.lat);
  if (lat != null) c.lat = lat;
  if (r.early_interval) c.early_interval = r.early_interval;
  if (r.late_interval) c.late_interval = r.late_interval;
  const maxMa = num(r.max_ma);
  if (maxMa != null) c.max_ma = maxMa;
  const minMa = num(r.min_ma);
  if (minMa != null) c.min_ma = minMa;
  if (r.formation) c.formation = r.formation;
  if (r.geological_group) c.geological_group = r.geological_group;
  if (r.member) c.member = r.member;
  // PBDB quotes some lithology/environment values — strip wrapping quotes.
  const lith = unquote(r.lithology1);
  if (lith) c.lithology = lith;
  const lithDesc = unquote(r.lithdescript);
  if (lithDesc) c.lithology_description = lithDesc;
  const env = unquote(r.environment);
  if (env) c.environment = env;
  if (r.cc) c.cc = r.cc;
  if (r.state) c.state = r.state;
  if (r.county) c.county = r.county;
  const nOccs = num(r.n_occs);
  if (nOccs != null) c.n_occs = nOccs;
  const refNo = intId(r.reference_no);
  if (refNo != null) c.reference_no = refNo;
  return c;
}

/** Strip surrounding double-quotes PBDB sometimes wraps free-text fields in. */
function unquote(s: string | undefined): string | undefined {
  if (!s) return;
  const trimmed = s
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
  return trimmed || undefined;
}

/** Human-facing label for a sanitized upstream failure, keyed by error code. */
function upstreamConditionFor(code: JsonRpcErrorCode): string {
  switch (code) {
    case JsonRpcErrorCode.Timeout:
      return 'timed out';
    case JsonRpcErrorCode.RateLimited:
      return 'is rate-limiting requests';
    case JsonRpcErrorCode.Forbidden:
    case JsonRpcErrorCode.Unauthorized:
      return 'refused the request';
    default:
      return 'is unavailable';
  }
}

/**
 * Operations whose PBDB endpoint answers an unmatched lookup with HTTP 400 +
 * `errors[]` rather than a 404. Only `taxa/single` does this, and only for a name
 * that fails PBDB's scientific-name pattern (`Invalid taxon name '…'`); every
 * other endpoint reserves 400 for a malformed PARAMETER, so a 400 there is a
 * parameter error and must never masquerade as a missing record.
 */
const OPERATIONS_WITH_NOT_FOUND_400 = new Set(['getTaxon']);

/**
 * Sanitize an error thrown by {@link fetchWithTimeout} into a clean, typed domain
 * error that leaks none of the raw upstream plumbing.
 *
 * Detection is STRUCTURAL — `err instanceof McpError` + its `.code`/`.data`, never
 * a string match on the message. Three outcomes:
 *  - PBDB not-found: a `NotFound`-coded error (HTTP 404 → unknown id or unmatched
 *    name), or a parameter rejection on one of {@link OPERATIONS_WITH_NOT_FOUND_400}
 *    → a clean {@link notFound} the caller remaps to its typed contract reason.
 *    PBDB's own error text is preserved in the message; the raw `data`
 *    (statusCode/statusText/responseBody/requestId) is dropped, replaced by
 *    `{ reason: 'pbdb_not_found' }`.
 *  - PBDB parameter rejection anywhere else: an `InvalidParams` McpError carrying
 *    PBDB's own rejection text, so a malformed filter reads as a bad parameter
 *    instead of "no match" or "upstream unavailable". The tool boundary guards
 *    should make this unreachable; it is the honest fallback if one is missed.
 *  - Anything else (403/429/5xx/timeout/network): a freshly-minted McpError of the
 *    SAME code (so withRetry's transient classification is preserved) with a
 *    generic, operation-scoped message and leak-free `data` (`{ operation }` only —
 *    no statusCode/responseBody/requestId/URL). The original is attached as `cause`
 *    for server-side logging, never serialized to the client.
 *
 * A non-McpError (not expected from fetchWithTimeout) bubbles unchanged — the
 * framework classifies it to code+message only, with no `data` to leak.
 */
function sanitizeUpstreamError(err: unknown, operation: string): unknown {
  if (!(err instanceof McpError)) return err;

  if (err.code === JsonRpcErrorCode.NotFound) {
    return notFound(pbdbNotFoundMessage(err, operation), { reason: 'pbdb_not_found' });
  }

  if (isPbdbParameterRejection(err)) {
    if (OPERATIONS_WITH_NOT_FOUND_400.has(operation)) {
      return notFound(pbdbNotFoundMessage(err, operation), { reason: 'pbdb_not_found' });
    }
    return new McpError(
      JsonRpcErrorCode.InvalidParams,
      `PBDB rejected the ${operation} query: ${pbdbErrorStrings(err).join('; ')}`,
      { operation, reason: 'pbdb_invalid_parameter' },
      { cause: err },
    );
  }

  return new McpError(
    err.code,
    `PBDB ${upstreamConditionFor(err.code)} during ${operation}.`,
    { operation },
    { cause: err },
  );
}

/**
 * True when a 400-class McpError's captured `responseBody` is a PBDB JSON body
 * carrying a non-empty `errors[]` array — PBDB's signal that it refused the
 * query as written. Structural: gated on the `InvalidParams`/`ValidationError`
 * codes the framework maps HTTP 400/422 to, then parses the body. What that
 * rejection MEANS is endpoint-specific; {@link sanitizeUpstreamError} decides.
 */
function isPbdbParameterRejection(err: McpError): boolean {
  if (
    err.code !== JsonRpcErrorCode.InvalidParams &&
    err.code !== JsonRpcErrorCode.ValidationError
  ) {
    return false;
  }
  return pbdbErrorStrings(err).length > 0;
}

/** The not-found message: PBDB's own error text when present, else a generic one. */
function pbdbNotFoundMessage(err: McpError, operation: string): string {
  const errors = pbdbErrorStrings(err);
  return errors.length > 0 ? errors.join('; ') : `PBDB found no match during ${operation}.`;
}

/** Extract PBDB's `errors[]` strings from a captured `data.responseBody`, or `[]`. */
function pbdbErrorStrings(err: McpError): string[] {
  const responseBody = (err.data as { responseBody?: unknown } | undefined)?.responseBody;
  if (typeof responseBody !== 'string') return [];
  try {
    const parsed = JSON.parse(responseBody) as { errors?: unknown };
    return Array.isArray(parsed.errors)
      ? parsed.errors.filter((e): e is string => typeof e === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * True when `err` is a NotFound McpError — what every PBDB service method throws
 * for a missing record (directly or via reclassified 4xx). Tools/resources use
 * it to remap the generic NotFound onto their own typed contract reason.
 */
export function isNotFoundError(err: unknown): err is McpError {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init / accessor
// ─────────────────────────────────────────────────────────────────────────────

let _service: PbdbService | undefined;

/** Initialize the PBDB service. Call in setup(). */
export function initPbdbService(config: AppConfig): void {
  _service = new PbdbService(config);
}

/** Resolve the PBDB service; throws if not initialized. */
export function getPbdbService(): PbdbService {
  if (!_service) {
    throw new Error('PbdbService not initialized — call initPbdbService() in setup()');
  }
  return _service;
}
