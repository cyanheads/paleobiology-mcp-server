/**
 * @fileoverview Domain and raw-upstream types for the Paleobiology Database (PBDB).
 *
 * Two layers:
 *  - `Pbdb*Record` — the raw shapes PBDB emits with `vocab=pbdb` (readable field
 *    names). Every geology/paleo/age-detail field is optional: PBDB sparsely
 *    populates paleo-coords, `late_interval`, `formation`, `lithology`, etc.
 *  - The normalized domain types (`Occurrence`, `Taxon`, …) the service returns
 *    and the tools surface. Absence is preserved as "unknown" — never defaulted
 *    to 0/empty-string.
 *
 * PBDB returns all numbers as JSON strings under some blocks (e.g. `lng`, `lat`,
 * `n_occs`) and as real numbers under others (e.g. `max_ma`, `paleolng`). The
 * normalizer coerces uniformly; raw types use `number | string` where observed.
 * @module services/pbdb/types
 */

/** PBDB taxonomic rank. Widened with `string` — PBDB ranks vary (e.g. "unranked clade"). */
export type TaxonRank =
  | 'subspecies'
  | 'species'
  | 'subgenus'
  | 'genus'
  | 'tribe'
  | 'subfamily'
  | 'family'
  | 'superfamily'
  | 'order'
  | 'class'
  | 'phylum'
  | 'kingdom'
  | 'unranked clade'
  | (string & {});

/** The coarse depositional-environment filter the agent picks. */
export type EnvironmentFilter = 'marine' | 'terrestrial' | 'freshwater';

/** The geologic-interval resolution for a diversity curve. */
export type DiversityResolution = 'period' | 'epoch' | 'age';

/** Taxa to count in a diversity curve. */
export type DiversityCount = 'genera' | 'species' | 'families';

/** Geologic-interval level in the bundled time scale. */
export type IntervalLevel = 'eon' | 'era' | 'period' | 'epoch' | 'age';

// ─────────────────────────────────────────────────────────────────────────────
// Raw upstream records (vocab=pbdb)
// ─────────────────────────────────────────────────────────────────────────────

/** Raw `/occs/list` + `/occs/single` record (vocab=pbdb, show=coords,loc,strat,class,paleoloc). */
export interface PbdbOccurrenceRecord {
  accepted_name?: string;
  accepted_no?: string;
  accepted_rank?: string;
  cc?: string;
  class?: string;
  collection_no?: string;
  county?: string;
  early_interval?: string;
  family?: string;
  formation?: string;
  genus?: string;
  geological_group?: string;
  geoplate?: string;
  identified_name?: string;
  identified_rank?: string;
  lat?: number | string;
  late_interval?: string;
  lng?: number | string;
  max_ma?: number;
  member?: string;
  min_ma?: number;
  occurrence_no: string;
  order?: string;
  paleolat?: number | string;
  paleolng?: number | string;
  paleomodel?: string;
  phylum?: string;
  reference_no?: string;
  state?: string;
}

/** Raw `/taxa/single` + `/taxa/list` record (vocab=pbdb, show=class,app,size,parent). */
export interface PbdbTaxonRecord {
  accepted_name?: string;
  accepted_no?: string;
  accepted_rank?: string;
  class?: string;
  difference?: string; // synonymy note, e.g. "subjective synonym of"
  early_interval?: string;
  extant_size?: number | string;
  family?: string;
  firstapp_max_ma?: number;
  firstapp_min_ma?: number;
  genus?: string;
  is_extant?: string; // "extant" | "extinct"
  lastapp_max_ma?: number;
  lastapp_min_ma?: number;
  late_interval?: string;
  n_occs?: number | string;
  order?: string;
  orig_no?: string;
  parent_name?: string;
  parent_no?: string;
  phylum?: string;
  reference_no?: string;
  taxon_name?: string;
  taxon_no: string;
  taxon_rank?: string;
  taxon_size?: number | string;
}

/** Raw `/occs/diversity` bin (vocab=pbdb). */
export interface PbdbDiversityRecord {
  implied_in_bin?: number;
  interval_name?: string;
  interval_no?: string;
  max_ma?: number;
  min_ma?: number;
  n_occs?: number;
  sampled_in_bin?: number;
  X_bL?: number; // last occ in bin, crosses BOTTOM boundary
  X_bt?: number; // crosses both boundaries (range-through)
  X_FL?: number; // found ONLY in bin (singleton — origination AND extinction)
  X_Ft?: number; // first occ in bin, crosses TOP boundary
}

/** Raw `/colls/list` record (vocab=pbdb, show=loc,strat,lith,env,time). */
export interface PbdbCollectionRecord {
  cc?: string;
  collection_aka?: string;
  collection_name?: string;
  collection_no: string;
  county?: string;
  early_interval?: string;
  environment?: string;
  formation?: string;
  geological_group?: string;
  lat?: number | string;
  late_interval?: string;
  lithdescript?: string;
  lithology1?: string;
  lithology2?: string;
  lng?: number | string;
  max_ma?: number;
  member?: string;
  min_ma?: number;
  n_occs?: number | string;
  reference_no?: string;
  state?: string;
}

/** Envelope every PBDB JSON response shares. */
export interface PbdbEnvelope<T> {
  elapsed_time?: number;
  errors?: string[];
  records?: T[];
  warnings?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized domain types (surfaced to the agent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fossil occurrence — one identified specimen-set at one collection.
 *
 * Declared as a `type` (not `interface`) so it satisfies the canvas `Row`
 * constraint (`Record<string, unknown>`) when spilled — interfaces don't get an
 * implicit index signature, type aliases of optional members do.
 */
export type Occurrence = {
  occurrence_no: number;
  collection_no?: number;
  identified_name?: string;
  identified_rank?: TaxonRank;
  accepted_name?: string;
  accepted_rank?: TaxonRank;
  accepted_no?: number;
  early_interval?: string;
  late_interval?: string;
  max_ma?: number;
  min_ma?: number;
  lng?: number;
  lat?: number;
  paleolng?: number;
  paleolat?: number;
  paleomodel?: string;
  geoplate?: string;
  formation?: string;
  geological_group?: string;
  member?: string;
  cc?: string;
  state?: string;
  county?: string;
  classification?: TaxonClassification;
  reference_no?: number;
};

/** Higher classification block. */
export type TaxonClassification = {
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
};

/** A first- or last-appearance window (FAD/LAD). */
export interface AppearanceWindow {
  interval?: string;
  max_ma?: number;
  min_ma?: number;
}

/** A taxon record + its fossil temporal range. */
export interface Taxon {
  accepted_name?: string;
  children?: TaxonStub[];
  classification: TaxonClassification;
  extant: boolean;
  occurrence_count?: number;
  parent_name?: string;
  parent_no?: number;
  range: {
    first_appearance: AppearanceWindow;
    last_appearance: AppearanceWindow;
  };
  rank?: TaxonRank;
  taxon_no: number;
}

/** A compact child-taxon stub. */
export interface TaxonStub {
  name?: string;
  occurrence_count?: number;
  rank?: TaxonRank;
  synonym_of?: string;
  taxon_no: number;
}

/** One diversity bin (one geologic interval). */
export interface DiversityBin {
  extinctions: number; // X_bL + X_FL — taxa whose last occurrence is in this bin
  implied: number;
  interval?: string;
  max_ma?: number;
  min_ma?: number;
  n_occurrences: number;
  originations: number; // X_Ft + X_FL — taxa whose first occurrence is in this bin
  range_through: number; // X_bt — taxa crossing both boundaries
  sampled_in_bin: number;
}

/** One geologic time interval (from the bundled snapshot). */
export interface Interval {
  abbrev?: string;
  color?: string;
  interval_no: number;
  level: IntervalLevel;
  max_ma: number;
  min_ma: number;
  name: string;
  parent_no?: number;
}

/** A fossil collection (locality). */
export interface Collection {
  cc?: string;
  collection_name?: string;
  collection_no: number;
  county?: string;
  early_interval?: string;
  environment?: string;
  formation?: string;
  geological_group?: string;
  lat?: number;
  late_interval?: string;
  lithology?: string;
  lithology_description?: string;
  lng?: number;
  max_ma?: number;
  member?: string;
  min_ma?: number;
  n_occs?: number;
  reference_no?: number;
  state?: string;
}

/** Filter args for an occurrence search. */
export interface OccurrenceFilter {
  baseName?: string;
  environment?: EnvironmentFilter;
  interval?: string;
  latmax?: number;
  latmin?: number;
  limit: number;
  lngmax?: number;
  lngmin?: number;
  maxMa?: number;
  minMa?: number;
  taxonName?: string;
}

/** Filter args for a collection search. */
export interface CollectionFilter {
  baseName?: string;
  environment?: EnvironmentFilter;
  formation?: string;
  interval?: string;
  latmax?: number;
  latmin?: number;
  limit: number;
  lithology?: string;
  lngmax?: number;
  lngmin?: number;
  maxMa?: number;
  minMa?: number;
  offset: number;
}

/** Filter args for a diversity curve. */
export interface DiversityFilter {
  baseName: string;
  count: DiversityCount;
  interval?: string;
  maxMa?: number;
  minMa?: number;
  resolution: DiversityResolution;
}

/** A paged collection result with truncation disclosure. */
export interface CollectionResult {
  /** The limit that was applied. */
  cap: number;
  collections: Collection[];
  /** Number of rows returned in this page. */
  shown: number;
  /** True when the page filled to the requested limit (more may exist). */
  truncated: boolean;
}

/** The CC-BY attribution string surfaced as provenance on every data response. */
export const PBDB_ATTRIBUTION =
  'Data from the Paleobiology Database (paleobiodb.org), licensed CC BY 4.0.';
