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
 *  - A not-found lookup returns HTTP 400 (invalid/unmatched taxon name) or 404
 *    (unknown id), each with an `errors[]` body — reclassified to a clean
 *    NotFound in {@link reclassifyPbdbHttpError}; some 200+`errors[]` cases are
 *    caught in {@link parseEnvelope}. Both surface as the caller's typed not-found.
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
  EnvironmentFilter,
  Occurrence,
  OccurrenceFilter,
  PbdbCollectionRecord,
  PbdbDiversityRecord,
  PbdbEnvelope,
  PbdbOccurrenceRecord,
  PbdbTaxonRecord,
  Taxon,
  TaxonClassification,
  TaxonStub,
} from './types.js';

/** PBDB `show` blocks per endpoint, grounded against the live API. */
const SHOW_BLOCKS = {
  occurrences: 'coords,loc,strat,class,paleoloc',
  taxa: 'class,app,size,parent',
  collections: 'loc,strat,lith,env,time',
} as const;

/** Map the agent-facing environment enum to PBDB `envtype` values. */
function envtypeFor(env: EnvironmentFilter): string {
  switch (env) {
    case 'freshwater':
      return 'lacustrine,fluvial';
    default:
      return env; // 'marine' | 'terrestrial' are direct macro-zones
  }
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

  constructor(_config: AppConfig) {
    const cfg = getServerConfig();
    this.baseUrl = cfg.pbdbBaseUrl.replace(/\/$/, '');
    this.timeoutMs = cfg.pbdbTimeoutMs;
  }

  // ── Request plumbing ───────────────────────────────────────────────────────

  /** Issue a GET against a PBDB endpoint, with retry + timeout. Returns parsed records. */
  private get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    operation: string,
  ): Promise<T[]> {
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
          response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, { signal: ctx.signal });
        } catch (err) {
          // PBDB answers a not-found / invalid-input lookup with HTTP 400 or 404
          // and a JSON body carrying `errors[]`. fetchWithTimeout throws those as
          // status-mapped McpErrors before we see the body — reclassify a 4xx whose
          // captured body reads as a PBDB not-found into a clean NotFound, so the
          // tool can map it to its typed contract reason (and we don't leak the raw
          // upstream status / requestId to the agent). 5xx and timeouts bubble for retry.
          const reclassified = reclassifyPbdbHttpError(err, operation);
          if (reclassified) throw reclassified;
          throw err;
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
   */
  private parseEnvelope<T>(text: string, operation: string): T[] {
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
    return body.records ?? [];
  }

  // ── Occurrences ─────────────────────────────────────────────────────────────

  /**
   * Search fossil occurrences. Returns an async generator so the spillover
   * helper can stream rows up to the configured cap.
   */
  async *searchOccurrences(filter: OccurrenceFilter, ctx: Context): AsyncGenerator<Occurrence> {
    const cap = Math.min(filter.limit, getServerConfig().pbdbMaxOccurrences);
    const params: Record<string, string | number | undefined> = {
      show: SHOW_BLOCKS.occurrences,
      limit: cap,
      base_name: filter.baseName,
      taxon_name: filter.taxonName,
      interval: filter.interval,
      max_ma: filter.maxMa,
      min_ma: filter.minMa,
      lngmin: filter.lngmin,
      lngmax: filter.lngmax,
      latmin: filter.latmin,
      latmax: filter.latmax,
      envtype: filter.environment ? envtypeFor(filter.environment) : undefined,
    };
    const records = await this.get<PbdbOccurrenceRecord>(
      'occs/list',
      params,
      ctx,
      'searchOccurrences',
    );
    for (const r of records) yield normalizeOccurrence(r);
  }

  /** Fetch one occurrence by its integer id. */
  async getOccurrence(occurrenceNo: number, ctx: Context): Promise<Occurrence> {
    const records = await this.get<PbdbOccurrenceRecord>(
      'occs/single',
      { id: `occ:${occurrenceNo}`, show: SHOW_BLOCKS.occurrences },
      ctx,
      'getOccurrence',
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

  /** Resolve a taxon by name or integer id; optionally include immediate children. */
  async getTaxon(
    args: { name?: string; taxonNo?: number; showChildren: boolean },
    ctx: Context,
  ): Promise<Taxon> {
    const idParam = args.taxonNo != null ? `txn:${args.taxonNo}` : undefined;
    const records = await this.get<PbdbTaxonRecord>(
      'taxa/single',
      { name: args.name, id: idParam, show: SHOW_BLOCKS.taxa },
      ctx,
      'getTaxon',
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
      const childRecords = await this.get<PbdbTaxonRecord>(
        'taxa/list',
        { id: `txn:${taxon.taxon_no}`, rel: 'children', show: 'app', limit: 200 },
        ctx,
        'getTaxonChildren',
      );
      taxon.children = childRecords
        .filter((c) => intId(c.taxon_no) !== taxon.taxon_no)
        .map(normalizeTaxonStub);
    }
    return taxon;
  }

  // ── Diversity ────────────────────────────────────────────────────────────────

  /** Compute a diversity / origination / extinction curve, binned by interval. */
  async getDiversity(filter: DiversityFilter, ctx: Context): Promise<DiversityBin[]> {
    const records = await this.get<PbdbDiversityRecord>(
      'occs/diversity',
      {
        base_name: filter.baseName,
        count: filter.count,
        time_reso: timeResoFor(filter.resolution),
        interval: filter.interval,
        max_ma: filter.maxMa,
        min_ma: filter.minMa,
      },
      ctx,
      'getDiversity',
    );
    return records.map(normalizeDiversityBin);
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  /** Search fossil collections (localities), paged inline. */
  async searchCollections(filter: CollectionFilter, ctx: Context): Promise<CollectionResult> {
    const cap = Math.min(filter.limit, getServerConfig().pbdbMaxOccurrences);
    const params: Record<string, string | number | undefined> = {
      show: SHOW_BLOCKS.collections,
      limit: cap,
      offset: filter.offset,
      base_name: filter.baseName,
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
    const records = await this.get<PbdbCollectionRecord>(
      'colls/list',
      params,
      ctx,
      'searchCollections',
    );
    const collections = records.map(normalizeCollection);
    return {
      collections,
      shown: collections.length,
      truncated: collections.length >= cap,
      cap,
    };
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
  if (r.taxon_rank) t.rank = r.taxon_rank;
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
  const b: DiversityBin = {
    sampled_in_bin: num(r.sampled_in_bin) ?? 0,
    implied: num(r.implied_in_bin) ?? 0,
    originations: xFt + xFl,
    extinctions: xBl + xFl,
    range_through: xBt,
    n_occurrences: num(r.n_occs) ?? 0,
  };
  if (r.interval_name) b.interval = r.interval_name;
  const maxMa = num(r.max_ma);
  if (maxMa != null) b.max_ma = maxMa;
  const minMa = num(r.min_ma);
  if (minMa != null) b.min_ma = minMa;
  return b;
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

/**
 * Reclassify a 4xx McpError from {@link fetchWithTimeout} into a clean NotFound
 * when PBDB's captured response body reads as a not-found / invalid-lookup error.
 * Returns undefined for anything that should bubble unchanged (5xx, timeouts,
 * non-PBDB shapes). Reads `data.statusCode` + `data.responseBody` that
 * fetchWithTimeout attaches to the thrown error.
 */
function reclassifyPbdbHttpError(err: unknown, operation: string): McpError | undefined {
  if (typeof err !== 'object' || err === null || !('data' in err)) return;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return;
  const statusCode = (data as { statusCode?: unknown }).statusCode;
  if (statusCode !== 400 && statusCode !== 404) return;

  const responseBody = (data as { responseBody?: unknown }).responseBody;
  let pbdbErrors: string[] | undefined;
  if (typeof responseBody === 'string') {
    try {
      const parsed = JSON.parse(responseBody) as { errors?: unknown };
      if (Array.isArray(parsed.errors)) {
        pbdbErrors = parsed.errors.filter((e): e is string => typeof e === 'string');
      }
    } catch {
      // Non-JSON body — fall through to the generic message below.
    }
  }
  const message = pbdbErrors?.length
    ? pbdbErrors.join('; ')
    : `PBDB found no match during ${operation}.`;
  return notFound(message, { reason: 'pbdb_not_found' });
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
