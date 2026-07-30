# paleobiology-mcp-server — Design

The deep-time counterpart to `gbif-biodiversity-mcp-server`: fossil biodiversity over the
[Paleobiology Database](https://paleobiodb.org) (PBDB), a community-curated record of where
and when life existed across ~540 million years. Keyless, CC BY.

> **Identity:** the display name is the hyphenated repo name `paleobiology-mcp-server` on
> every surface (`createApp()` `name`/`title`, manifest `display_name`, docs headers).
> Never a Title-Cased "Pretty Name". The tool prefix is `paleobiology_`.

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `paleobiology_search_occurrences` | Fossil occurrences filtered by taxon, geologic interval (named or Ma range), geographic bbox, and environment. The flagship. Large sets spill to DataCanvas. | `true` | `true` | `base_name` (clade-inclusive) \| `base_id` (clade-inclusive, positive int) \| `taxon_name` (exact), `interval` \| (`max_ma` ≥0, `min_ma` ≥0), `lngmin`/`lngmax`/`latmin`/`latmax` (bbox, degrees), `environment` (enum: `"marine"` \| `"terrestrial"` \| `"freshwater"` — optional), `limit` (int, 1–500, default 100), `offset` (int, ≥0, default 0), `canvas_id` | `{ occurrences[], total, truncated?, canvas_id?, table_name?, spilled }` |
| `paleobiology_get_taxon` | Taxonomic record + fossil temporal range (FAD/LAD) by name or `taxon_no`: accepted name, rank, classification, parent + immediate children, occurrence count, and `taxon_no` for chaining into occurrence/diversity searches. Resolves names for the other tools. | `true` | `true` | `name` (string) \| `taxon_no` (positive int — from prior `get_taxon` or `accepted_no` on occurrence rows), `show_children` (bool, default false), `children_offset` (int, ≥0, default 0) | `{ taxon { taxon_no, accepted_name, rank, … }, classification, parent?, children[], children_offset?, children_truncated?, range, occurrence_count }` |
| `paleobiology_get_diversity` | Diversity / origination / extinction through time for a clade over an interval, binned by period/epoch/age. Returns the full bin set inline — a diversity curve is a bounded set of geologic-interval bins (≤ ~100), small enough to inline. | `true` | `true` | `base_name` \| `base_id` (exactly one required), `count` (enum: `"genera"` \| `"species"` \| `"families"`, default `"genera"`), `resolution` (enum: `"period"` \| `"epoch"` \| `"age"`, default `"period"`), `interval` \| (`max_ma` ≥0, `min_ma` ≥0) | `{ bins[] }` |
| `paleobiology_list_intervals` | The geologic time scale: eons→ages with absolute-age boundaries (Ma) and nesting. Reference lookup that grounds every temporal filter; translates "Late Cretaceous" ↔ "100.5–66.0 Ma". Browsing and every international-scale name come from the bundled ICS snapshot with no upstream call; a name outside it (`Late Maastrichtian`, `Lancian`) costs one PBDB lookup across the other scales. | `true` | `true` | `name` (substring match against the snapshot, exact match upstream), `min_ma` (≥0), `max_ma` (≥0), `level` (enum: `"eon"` \| `"era"` \| `"period"` \| `"epoch"` \| `"age"`) | `{ intervals[{ …, scale? }], source, snapshot_version }` |
| `paleobiology_search_collections` | Fossil collections (localities) by area + interval: location, age, formation/strata, lithology, depositional environment, and co-occurring taxa count. The "what's been dug up here, from what rock" view — a find-then-drill-in locality index, returned paginated inline. | `true` | `true` | `base_name` \| `base_id`, `interval` \| (`max_ma` ≥0, `min_ma` ≥0), `lngmin`/`lngmax`/`latmin`/`latmax` (bbox), `formation`, `lithology`, `environment` (enum: same as occurrences), `limit` (int, 1–500, default 100), `offset` (int, ≥0, default 0) | `{ collections[{ collection_no, … }], total, truncated?, shown }` |
| `paleobiology_dataframe_query` | Run a read-only SQL `SELECT` over occurrence result sets staged on a DataCanvas by `paleobiology_search_occurrences` (count by interval, group by formation/country/lithology, map by region). | `true` | `false` | `canvas_id`, `sql` (SELECT only) | `{ rows[], row_count, truncated? }` |
| `paleobiology_dataframe_describe` | List the tables and columns staged on a canvas — discover names before writing SQL for `paleobiology_dataframe_query`. | `true` | `false` | `canvas_id` | `{ tables[{ name, kind, row_count, columns[] }] }` |
| `paleobiology_dataframe_drop` | Drop a staged table from a canvas to free memory before its TTL expires. Opt-in — registered only when `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true`. | `false` | `false` | `canvas_id`, `table_name` | `{ dropped }` |

Tool counts: **7–8 tools** — 5 domain/workflow tools + the standardized
3-tool DataCanvas set, of which 2 always register and 1 is opt-in. Exactly **one** domain tool
spills to a canvas: `paleobiology_search_occurrences` (occurrence rows are tabular and
analytical — count by interval, group by formation/country/lithology over large broad-query
sets). `paleobiology_get_diversity` and `paleobiology_search_collections` were pruned from the
spill path by the earns-its-keep gate (see Design Decisions). The DataCanvas standard for any
server that still spills is three tools:
`paleobiology_dataframe_query` (mandatory — the framework's contract is hard: **any tool that
emits a `canvas_id` MUST ship a `dataframe_query` tool in the same server, or the `canvas_id`
is dead output the agent cannot reach**), `paleobiology_dataframe_describe` (lists staged
tables/columns so the agent can discover names before writing SQL), and
`paleobiology_dataframe_drop` (opt-in, registered only when
`PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true`, default off — so the default surface is 7 tools,
8 with drop enabled). See `api-canvas`.

### Resources

| URI Template | Returns | Tool-coverage note |
|---|---|---|
| `paleobiology://occurrence/{occurrence_no}` | One fossil occurrence (full `show` blocks: coords + paleo-coords, classification, strata, locality). | Convenience mirror of a single-occurrence read; `paleobiology_search_occurrences` covers the same data for tool-only clients. |
| `paleobiology://taxon/{taxon_no}` | One taxon record + fossil range + classification. | Mirror of `paleobiology_get_taxon` by `taxon_no`. |

Resources are supplementary (many clients are tool-only). Both are read-only, stable-URI,
useful-as-injectable-context lookups whose data is fully reachable through the tool surface.
`occurrence_no` and `taxon_no` are bare integers obtained from
`paleobiology_search_occurrences` / `paleobiology_get_taxon` output respectively.

### Prompts

None in v1. The server is data/lookup-oriented; there is no recurring multi-step interaction
pattern that a prompt template improves over the tool descriptions. (A future
`fossil_vs_living` prompt that scaffolds the GBIF cross-domain comparison is a candidate —
deferred.)

---

## Overview

PBDB is a single keyless provider at `https://paleobiodb.org/data1.2/`. It answers the
deep-time questions the rest of the biodiversity fleet can't: where and *when* a clade lived,
when it first appeared, when it went extinct, and how its diversity rose and fell across
geologic time. `gbif-biodiversity-mcp-server` answers "where does this species live *now*";
this server answers "where and *when* did this lineage live, and when did it die out." The
pairing — modern + fossil occurrences of one lineage across the whole of time — is the
headline cross-domain story (see Workflow Analysis #4).

Queries combine three filter axes: **taxonomic** (a taxon name, or the resolved integer
`taxon_no`), **temporal** (a named interval like `Cretaceous`, or a `max_ma`/`min_ma` range
in millions of years), and **spatial** (a lat/lng bounding box). The native temporal axis is
geologic time, so every temporal answer echoes **both** the named interval and the absolute
Ma boundaries. `paleobiology_list_intervals` is the rosetta stone that lets an agent move
between the two.

The primary agent workflows: (1) find fossil occurrences of a taxon and map where/when it
lived; (2) get a taxon's fossil range (first/last appearance, extinction); (3) plot diversity
or extinction/origination through time for a clade; (4) translate named intervals ↔ Ma; (5)
find localities in a region and the strata + fauna they yield; (6) reconcile a fossil lineage
against its living relatives in GBIF.

**The compact-field-codes gotcha is the central implementation concern.** PBDB returns terse
codes (`tna`, `oei`, `lng`, `fea`) by default. The fix is the upstream `vocab=pbdb` parameter,
which makes PBDB itself emit readable field names (`accepted_name`, `early_interval`, `lng`,
`firstapp_max_ma`) — verified against the live API. The service layer passes `vocab=pbdb` on
every request and the right `show` blocks per tool; raw codes never reach the agent.

---

## Requirements

**Functional**

- Search fossil occurrences by any combination of taxon, geologic interval (named or Ma
  range), geographic bbox, and depositional environment.
- Resolve a taxon name → accepted name + integer `taxon_no`, full classification, parent +
  immediate children, occurrence count, and FAD/LAD fossil range.
- Compute diversity / origination / extinction through time for a clade, binned at a
  selectable resolution (period / epoch / age).
- Look up geologic intervals and their absolute-age (Ma) boundaries and nesting, both
  name→Ma and Ma→names.
- Find fossil collections (localities) by area + interval with their strata, lithology,
  environment, and co-occurring taxa.
- Surface **both** coordinate systems on every occurrence — modern lat/lng and
  paleo-coordinates (where the landmass sat at the time) — distinctly labeled.
- Echo **both** named interval and Ma boundaries on every temporal result.
- Stage large analytical occurrence result sets on a DataCanvas and expose read-only SQL over
  them. Diversity bins (bounded, ≤ ~100) and collection localities (a find-then-drill-in
  index) return inline — paginated/capped, not staged (see Design Decisions: earns-its-keep
  gate).

**Non-functional / constraints**

- **No auth, no API key.** PBDB is fully open. Server runs in `MCP_AUTH_MODE=none`; tools
  carry no auth scopes.
- **Licensing / attribution:** PBDB data is **CC BY** — downstream use must credit the
  Paleobiology Database. Surface the attribution in the server `instructions` and note it in
  occurrence/collection output provenance.
- **Rate limits:** PBDB publishes no hard rate limit; it is a research database, not a
  high-QPS service. Be a good citizen — single requests per tool call, `withRetry` with
  modest backoff (degraded-upstream tier), and lean on the bundled interval snapshot so
  browsing the time scale and every international-scale name cost no request at all.
- **Data freshness:** occurrence/taxon/diversity/collection data is live (queried per call).
  The geologic time scale changes rarely (ICS revisions) and is bundled as a static snapshot;
  document the snapshot's ICS version and refresh on ICS updates. The snapshot covers only the
  ICS international scale, so a name from one of PBDB's other 64 scales — the sub-stage and
  regional names occurrence and collection rows report — is resolved live on a snapshot miss
  and labeled with its source and scale.
- **Paging:** PBDB list endpoints accept `limit` + `offset`, and `rowcount` adds
  `records_found` (the true match count, independent of paging) to the envelope. The list
  searches send it, so truncation is a known fact rather than an inference and the disclosure
  (`truncated`, `shown`, `cap` via `ctx.enrich.truncated(...)`, plus `totalCount` via
  `ctx.enrich.total(...)`) states the real remainder. Cost: an upstream COUNT pass per call.
  PBDB's companion `records_returned` is not usable — it goes negative once `offset` runs past
  the end — so count the parsed rows instead.
- **Zod constraints:** `occurrence_no` / `taxon_no` / `collection_no` → `z.number().int().positive()`; `max_ma` / `min_ma` → `z.number().nonnegative()`; `limit` → `z.number().int().min(1).max(500).default(100)`; bbox fields → `z.number()` with coordinate-range bounds (`lng` −180…180, `lat` −90…90); `environment`, `count`, `resolution`, `level` → `z.enum([...])`. Format constraints live in Zod validators, not only in `.describe()` prose.

**Out of scope (v1)**

- Writing to PBDB (it is read-only; PBDB edits happen through its own authenticated UI).
- Phylogenetic tree reconstruction / cladistics beyond PBDB's stored parent/child taxonomy.
- Paleo-map image rendering (we return paleo-coordinates as numbers; plotting is the client's
  job).
- The future `macrostrat` rock-column integration (separate server).

---

## Data Model

PBDB IDs are integers, often surfaced in a prefixed form (`occ:139292`, `txn:54833`,
`col:11917`, `int:111`). The service strips/adds the prefix as the endpoint requires
(`occs/single` takes `id=occ:NNN` or a bare integer; list filters take bare integers). Tools
surface **bare integers** to the agent and document which tool emits each.

> **How an agent obtains each ID:**
> - `occurrence_no` ← `paleobiology_search_occurrences` output rows.
> - `taxon_no` ← `paleobiology_get_taxon` (resolve a name first) — also appears as
>   `accepted_no` on occurrence rows. It is the `base_id` the occurrence, diversity, and
>   collection searches accept in place of a `base_name`.
> - `collection_no` ← `paleobiology_search_occurrences` (each occurrence carries its
>   collection ref) or `paleobiology_search_collections` output.
> - `canvas_id` ← `paleobiology_search_occurrences` when a result spills (the only tool that
>   stages a canvas).

```ts
/** A fossil occurrence — one identified specimen-set at one collection. */
interface Occurrence {
  occurrence_no: number;          // PBDB occurrence id (bare int)
  collection_no: number;          // the locality this came from → search_collections
  identified_name: string;        // the original field/published identification
  identified_rank: TaxonRank;     // rank of the identified name
  accepted_name: string;          // PBDB's resolved accepted name (may differ from identified)
  accepted_rank: TaxonRank;
  accepted_no: number;            // taxon_no of the accepted name → get_taxon
  // Age — ALWAYS surface named interval AND Ma boundaries together:
  early_interval: string;         // e.g. "Late Maastrichtian"
  late_interval?: string;         // present when the age spans two named intervals
  max_ma: number;                 // older bound (Ma)
  min_ma: number;                 // younger bound (Ma)
  // Two coordinate systems — label distinctly, never conflate:
  lng: number; lat: number;       // MODERN position (where the rock is today)
  paleolng?: number; paleolat?: number; // PALEO position (where it sat at deposition)
  paleomodel?: string;            // plate model used (e.g. "gplates")
  geoplate?: string;              // tectonic plate id
  // Geology / locality:
  formation?: string;             // geologic formation
  cc?: string;                    // ISO country code
  state?: string;
  reference_no: number;           // PBDB bibliographic ref
}

/** A taxon record + its fossil temporal range. */
interface Taxon {
  taxon_no: number;               // accepted taxon id (bare int)
  accepted_name: string;
  rank: TaxonRank;
  parent_no?: number;             // immediate parent taxon
  classification: {               // higher classification (from the `class` block)
    phylum?: string; class?: string; order?: string; family?: string; genus?: string;
  };
  extant: boolean;                // ext flag — does the clade survive to today?
  occurrence_count: number;       // noc — number of fossil occurrences
  range: {                        // FAD/LAD, from the `app` block — each a Ma window:
    first_appearance: { max_ma: number; min_ma: number; early_interval: string };
    last_appearance:  { max_ma: number; min_ma: number; late_interval: string };
  };
  children?: TaxonStub[];         // immediate children when show_children=true
}

/** One diversity bin (one geologic interval). */
interface DiversityBin {
  interval: string;               // bin name (e.g. "Cretaceous")
  max_ma: number; min_ma: number; // bin boundaries
  sampled_in_bin: number;         // dsb — taxa with occurrences inside this bin
  implied: number;                // dib — taxa implied present in the bin but without an occurrence in it
  originations: number;           // X_Ft + X_FL — taxa first appearing in this bin (new FADs + bin-only singletons)
  extinctions: number;            // X_bL + X_FL — taxa last appearing in this bin (LADs + bin-only singletons)
  range_through: number;          // X_bt — taxa whose range crosses both bin boundaries (present before and after)
  n_occurrences: number;          // noc — total occurrence count in bin
}

/** One geologic time interval (from the bundled time-scale snapshot). */
interface Interval {
  interval_no: number;            // int:NNN
  name: string;                   // "Maastrichtian"
  level: 'eon' | 'era' | 'period' | 'epoch' | 'age';
  max_ma: number;                 // older boundary (e.g. 72.2)
  min_ma: number;                 // younger boundary (e.g. 66.0)
  parent_no?: number;             // containing interval (epoch→period→era→eon)
  color?: string;                 // ICS chart color (e.g. "#FDB462")
}

/** A fossil collection (locality). */
interface Collection {
  collection_no: number;
  collection_name?: string;
  lng: number; lat: number;       // modern position
  early_interval: string; late_interval?: string; max_ma: number; min_ma: number;
  formation?: string;             // strata block
  lithology?: string;             // lith block
  environment?: string;           // env block — depositional environment
  cc?: string; state?: string;
  n_occs: number;                 // co-occurring fossils at this locality
  reference_no: number;
}

type TaxonRank =
  | 'subspecies' | 'species' | 'genus' | 'subgenus' | 'family' | 'order'
  | 'class' | 'phylum' | 'kingdom' | 'unranked clade' | string; // PBDB ranks; widened
```

**Field-code mapping is not hand-maintained.** Passing `vocab=pbdb` upstream makes PBDB emit
the readable names above directly (verified: `accepted_name`, `early_interval`,
`firstapp_max_ma`, etc.). The service requests `vocab=pbdb` plus the `show` blocks each tool
needs; the few derived fields (FAD/LAD windows, origination/extinction sums from the diversity
block's boundary-crosser counts) are computed in the normalizer.

---

## Services

| Service | Responsibility | Key methods |
|---|---|---|
| `PbdbService` (`src/services/pbdb/pbdb-service.ts`) | The PBDB HTTP client. Builds requests with `vocab=pbdb` + per-tool `show` blocks, wraps `fetchWithTimeout` + `withRetry`, parses + normalizes compact responses into the `Data Model` types, and carries the envelope metadata — upstream `warnings[]` and the `rowcount` match count — out alongside the records. One method per resource family. `searchOccurrences` returns a handle (`{ rows, meta }`) rather than a bare generator: `spillover()` and `for await` both discard a generator's return value, so the total and warnings need a channel the caller still holds after the drain. `lookupInterval` is the exception to "one method per family" being purely record-shaped: it also resolves the `scale_no` → scale-name directory (a separate `timescales/list` call, cached per process) so an off-international-scale hit is labeled rather than tagged with an opaque number. | `searchOccurrences(filter)`, `getOccurrence(id)`, `getTaxon({name\|taxonNo, showChildren})`, `getDiversity(filter)`, `searchCollections(filter)`, `lookupInterval(name)` |
| `IntervalIndex` (`src/services/intervals/interval-index.ts`) | In-memory index over the **bundled** geologic time-scale snapshot (the ICS international scale, `scale_id=1`). Backs the offline half of `paleobiology_list_intervals` — browsing and every international-scale name — with no network call, and provides name↔Ma resolution the other services use to validate/echo temporal filters. Small bounded set (171 intervals) → server-level in-memory index, not a `MirrorService` and not a DataCanvas. **Only the ICS international scale is bundled** — no `scale` input filter is exposed; the snapshot's ICS version and generation date are surfaced as `snapshot_version` in the `paleobiology_list_intervals` output so consumers can cite it. The index stays synchronous: the upstream fallback for a name it does not carry lives in the tool handler, which owns the network call and the `source` labeling. | `byName(name)`, `filter(opts)`, `all(level?)`, plus the module-level `filterIntervals(intervals, opts)` the handler reuses on an upstream hit |
| `canvas-accessor` (`src/services/canvas-accessor.ts`) | Module-level `getCanvas()`/`setCanvas()` accessor wired from `setup(core)`. The spill path: the `paleobiology_search_occurrences` handler `spillover()`s large occurrence result sets onto a canvas; the `dataframe_*` tools query/describe/drop it. | `getCanvas()`, `setCanvas(core.canvas)` |

The interval snapshot is a checked-in TypeScript module (`src/services/intervals/time-scale-data.ts`)
derived once from PBDB `/intervals/list?scale_id=1` (the ICS international scale). It is loaded
into the index at startup. Rationale: the time scale changes only on ICS revision (years
apart), grounds every other tool's temporal filter, and bundling it makes the lookup instant
and offline. (Not the `MirrorService` — that tier is for ~10⁴–10⁷-row corpora; 171 intervals
is a plain in-memory index.)

**Decision — the snapshot is the default, the network is the fallback.** Bundling all 1,909
intervals across PBDB's 65 scales would keep the tool fully offline but bloat the browse surface
with mostly-regional rows and go stale; documenting the ICS-only scope would leave the natural
row → lookup chain broken, since occurrence and collection rows routinely report names from the
sub-stage and regional scales. So the snapshot still answers browsing and every name it carries
with no request, and only a name it does not carry at all reaches PBDB. A name the snapshot knows
that is excluded by a `level`/Ma filter is a bundled answer, not a miss — the handler re-checks the
name alone before deciding to reach out, so the offline guarantee holds on every known name.
An unreachable PBDB surfaces as `interval_lookup_unavailable` (retryable), never as
`interval_not_found`: telling an agent a real interval does not exist is worse than telling it
to retry.

---

## Config

`src/config/server-config.ts` — a lazy-parsed Zod schema, separate from framework config, via
`parseEnvConfig` (maps schema paths → env var names so errors name the variable).

| Env Var | Field | Required | Default | Purpose |
|---|---|---|---|---|
| `PBDB_BASE_URL` | `pbdbBaseUrl` | optional | `https://paleobiodb.org/data1.2` | PBDB API base; override for a mirror/proxy or pinned API version. |
| `PBDB_TIMEOUT_MS` | `pbdbTimeoutMs` | optional | `30000` | Per-request timeout. Diversity queries over large clades can take ~0.5s+ upstream; keep generous. |
| `PBDB_MAX_OCCURRENCES` | `pbdbMaxOccurrences` | optional | `1000` | Hard cap on rows pulled per occurrence call before the canvas spill closes the stream. Also bounds the inline collection list (it pages, never spills). |
| `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED` | `dataframeDropEnabled` | optional | `false` | Set to `true` to register `paleobiology_dataframe_drop`. Off by default — the tool is conditionally registered, so it's absent from the surface unless opted in. Use `z.stringbool()`, not `z.coerce.boolean()`. |
| `CANVAS_PROVIDER_TYPE` | (framework) | optional | `none` | Set to `duckdb` to enable DataCanvas. When `none`, `paleobiology_search_occurrences` returns its inline preview only (no usable `canvas_id`) and the `dataframe_*` tools throw a clear "canvas disabled" error. |

No API key — PBDB is keyless. Without `CANVAS_PROVIDER_TYPE=duckdb` the server degrades
gracefully: `paleobiology_search_occurrences` still returns its inline preview and `total`, it
just doesn't emit a usable `canvas_id`, and the `dataframe_*` tools fail with an actionable
message naming the env var to set. (Diversity and collections never spill, so the canvas flag
doesn't affect them at all.)

`@duckdb/node-api` is an optional peer dependency (`bun add @duckdb/node-api`) — only needed
when canvas is enabled; zero install cost otherwise.

---

## Implementation Order

Each step is independently buildable + testable.

1. **Config + server identity.** `server-config.ts` (Zod schema, env mapping); set
   `createApp()` `name`/`title` to `paleobiology-mcp-server`, add CC-BY attribution +
   modern-vs-paleo-coords guidance to `instructions`. Remove echo definitions.
2. **`IntervalIndex` + bundled snapshot.** Generate `ics-time-scale.json` from PBDB
   `/intervals/list?scale_id=1` once; record the ICS version and generation date in the file's
   top-level metadata (e.g. `{ "ics_version": "2023/09", "generated": "2025-01-01", "intervals": [...] }`);
   build the index + `paleobiology_list_intervals` (no upstream dep — fastest to land and
   test, and it's the temporal rosetta the rest leans on). Surface `snapshot_version` in the
   tool output.
3. **`PbdbService` core + `paleobiology_get_taxon`.** Request builder with `vocab=pbdb`,
   retry/timeout, normalizer; name→`taxon_no` resolution + FAD/LAD range. This is the
   name-resolution gateway the occurrence/diversity tools depend on.
4. **`paleobiology_search_occurrences`.** The flagship. Occurrence filter (taxon × interval ×
   bbox × environment), modern + paleo coords, inline preview + `total`. Land it *before*
   wiring canvas so the read path is verifiable on its own.
5. **DataCanvas spill + the 3-tool dataframe set.** `canvas-accessor`, wire `setCanvas` in
   `setup()`, add `spillover()` to `paleobiology_search_occurrences` (the only spilling tool).
   Ship `paleobiology_dataframe_query` + `paleobiology_dataframe_describe` together (the
   `canvas_id`-without-query-tool rule), and `paleobiology_dataframe_drop` conditionally
   registered behind `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED` (off by default).
6. **`paleobiology_get_diversity`.** Diversity/origination/extinction binning, returned inline
   — a bounded bin set (≤ ~100 geologic intervals), no canvas spill.
7. **`paleobiology_search_collections`.** Locality search + strata/lithology/environment,
   returned paginated inline (`limit`/`offset`, truncation disclosed) — a find-then-drill-in
   index, no canvas spill. Note the `colls/list` `show`-block difference (no `coords`).
8. **Resources.** `paleobiology://occurrence/{occurrence_no}` and
   `paleobiology://taxon/{taxon_no}` over the existing service methods.
9. **Polish.** Tests (incl. a sparse-payload case per tool — PBDB omits paleo-coords,
   `late_interval`, `formation` routinely), `devcheck`, README/metadata, security pass.

---

## Workflow Analysis

**1 · "When and where did Tyrannosaurus live?"**

| # | Tool | Why |
|---|---|---|
| 1 | `paleobiology_get_taxon` (`name: "Tyrannosaurus"`) | Resolve the name → accepted `taxon_no` (54833), confirm rank, get the FAD/LAD range (≈83.6–66.0 Ma). |
| 2 | `paleobiology_search_occurrences` (`base_name: "Tyrannosaurus"`) | Map the occurrences — each row carries modern lat/lng (plot today) **and** paleolat/paleolng (where the landmass sat in the Maastrichtian), plus formation + interval. |

The hop: tool 1's accepted name (or `base_name`) feeds tool 2. The agent must not plot a
Cretaceous occurrence on a modern coastline — the output labels modern vs. paleo coords so it
picks the right one.

**2 · "Plot dinosaur genus diversity across the Mesozoic."**

| # | Tool | Why |
|---|---|---|
| 1 | `paleobiology_list_intervals` (`name: "Mesozoic"`) | Translate "Mesozoic" → 251.9–66.0 Ma boundaries to bound the query (or pass the named era directly). |
| 2 | `paleobiology_get_diversity` (`base_name: "Dinosauria"`, `count: "genera"`, `resolution: "period"`, `max_ma: 251.9`, `min_ma: 66`) | Returns per-period bins with genus counts + origination/extinction, inline — the Mesozoic is ~3 periods (or ~10 epochs / ~30 ages at finer resolution), a bounded bin set that fits the response. |

The bins arrive in one call; the agent reads the curve, the turnover, and the
origination/extinction directly from the inline set. No canvas hop — a diversity series tops
out at the geologic-interval count (≤ ~100 even at age resolution), so it fails the size gate
and is inlined (see Design Decisions: earns-its-keep gate).

**3 · "What fossils have been dug up in Hell Creek, and from what rock?"**

| # | Tool | Why |
|---|---|---|
| 1 | `paleobiology_search_collections` (`formation: "Hell Creek"`, or a bbox + `interval: "Maastrichtian"`) | Localities with strata, lithology, depositional environment, and `n_occs` co-occurring fossils. |
| 2 | `paleobiology_search_occurrences` (filtered to a `collection_no` from step 1, or the same bbox+interval) | The actual fauna found together at that locality. |

The hop: a `collection_no` from tool 1's rows scopes tool 2 (each occurrence also carries its
own `collection_no` back-reference).

**4 · The GBIF cross-domain pairing — "Panthera across all of time."** (the headline demo)

| # | Server · Tool | Why |
|---|---|---|
| 1 | `paleobiology_get_taxon` (`name: "Panthera"`) | PBDB's accepted name + fossil range. |
| 2 | `paleobiology_search_occurrences` (`base_name: "Panthera"`) | Fossil (extinct) occurrences — deep-time half of the lineage. |
| 3 | `gbif-biodiversity-mcp-server` · `gbif_match_species` → `gbif_search_occurrences` | Living (extant) occurrences — the modern half. |

Both servers resolve against GBIF-backbone-style taxonomy, so names line up. The agent must
note that PBDB's accepted-name resolution can differ from GBIF's backbone (Design Decisions) —
a reconciliation surfaced as the `identified_name` vs `accepted_name` split.

---

## Design Decisions

- **5 domain tools, not a PBDB endpoint mirror.** Each tool is a user goal ("when did this
  live", "plot diversity"), not a 1:1 wrap of `/occs/list` etc. The `/taxa/single` +
  `/taxa/list` pair collapses into one `paleobiology_get_taxon` (range + classification +
  children in one call); `/occs/diversity` + `/occs/prevalence` collapse into
  `paleobiology_get_diversity`.
- **`vocab=pbdb` over hand-mapped field codes.** The live API emits readable field names when
  asked. Mapping `tna`→`accepted_name` by hand is fragile and would drift; let PBDB do it.
  (The normalizer still computes the few derived fields — FAD/LAD windows, diversity
  origination/extinction sums.)
- **Bundle the geologic time scale, query everything else live.** The ICS scale changes on a
  years-long cadence and grounds every temporal filter, so it ships as a static snapshot
  behind an in-memory index. Occurrences/taxa/diversity/collections are live. Chosen over
  `MirrorService` because 171 intervals is far below that tier's ~10⁴-row floor. Every domain
  tool carries `openWorldHint: true` — the interval lookup included, since a name outside the
  bundled scale reaches PBDB; only the canvas-local `dataframe_*` tools are `false`.
- **Always echo both temporal representations and both coordinate systems.** Named interval
  **and** Ma boundaries on every age; modern **and** paleo lat/lng on every occurrence,
  distinctly labeled. This is the single most important correctness guard — it stops an agent
  conflating "where it is now" with "where it lived" or a named stage with its absolute age.
- **Surface `identified_name` alongside `accepted_name`.** PBDB has opinionated synonymy. The
  original identification + the accepted name together let an agent see reconciliation and
  flag where PBDB taxonomy diverges from GBIF's backbone.
- **DataCanvas spill for occurrences only — the earns-its-keep gate, applied per tool.** The
  `api-canvas` gate requires **both**: (1) the data is *analytical* — an agent writes
  `SELECT … GROUP BY` over it, not a discovery/search surface of categorical metadata
  (disqualified regardless of row count); and (2) it's *too big to inline* (> ~100 rows).
  Applying it tool by tool:
  - `paleobiology_search_occurrences` — **spills.** Occurrence rows are tabular and analytical
    (count by interval, group by formation/country/lithology over large broad-`base_name`
    sets), and broad queries blow past the inline budget. Passes both gates.
  - `paleobiology_get_diversity` — **inline, no spill.** A diversity curve is a bounded set of
    geologic-interval bins (≤ ~100 even at age resolution), so it fails the size gate. The
    series is analytical, but it fits the response — inline it; the agent reads the curve and
    turnover directly without an SQL round-trip.
  - `paleobiology_search_collections` — **inline, no spill.** Collections are a find-then-
    drill-in locality index (resolve localities in a region → drill into the rock/fauna, or
    chain a `collection_no` into occurrence search), i.e. discovery-shaped categorical
    metadata — disqualified by gate (1) regardless of how many localities match. The
    aggregations that matter (group by formation / environment / interval) live on the
    occurrence rows, which already spill. Returned paginated/capped inline (`limit`/`offset`,
    truncation disclosed) instead.
  - `paleobiology_get_taxon` / `paleobiology_list_intervals` — single record / bounded
    reference list (discovery shape); never spilled.

  Because exactly one tool emits a `canvas_id`, the standardized DataCanvas set still applies:
  `paleobiology_dataframe_query` (mandatory — a `canvas_id` with no query tool is dead output),
  `paleobiology_dataframe_describe` (table/column discovery), and `paleobiology_dataframe_drop`
  (opt-in via `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED`, default off, conditionally registered).
- **`base_name` (clade-inclusive) is the default taxon filter** for occurrence/diversity/
  collection search, with `taxon_name` (exact) as the narrower option — PBDB's `base_name`
  pulls a taxon and all its descendants, which is what "dinosaur diversity" or "Panthera
  occurrences" almost always means.
- **`base_id` is the same clade filter keyed by id** (PBDB `base_id=txn:<n>`), on all three
  taxon-filtered searches, so the `taxon_no` `paleobiology_get_taxon` resolves has somewhere to
  go instead of the agent re-sending a name string and re-introducing the ambiguity resolution
  removed. `base_name` and `base_id` are mutually exclusive: PBDB rejects the pair with HTTP
  400, but each tool guards it locally (`conflicting_taxon_filter`) so the agent gets a typed
  reason and a tailored recovery hint rather than PBDB's own wording. `paleobiology_get_diversity`'s
  `base_name` is optional as a result — exactly one of the two selectors is required, enforced by
  its `missing_filter` guard.
- **`environment` is a coarse enum, not a free string.** PBDB's `envtype` accepts a limited
  vocabulary (`"marine"`, `"terrestrial"`, `"freshwater"`). The Zod enum must match this
  exactly; the `.describe()` lists all valid values so a weaker model doesn't invent values.
  The implementation must verify this enum against the live API during scaffolding — PBDB may
  expand it.
- **`paleobiology_` prefix, not `pbdb_`.** The repo name is canonical and self-descriptive;
  `pbdb_` reads as an obscure acronym outside the field (per the naming skill and idea.md).
- **No write tools, no app tools, no prompts in v1.** PBDB is read-only; the workflows are
  read-by-LLM, not viewed-by-human; no recurring interaction pattern justifies a prompt.

---

## Output Design Notes

- **Spill trigger.** Only `paleobiology_search_occurrences` spills. Its handler uses
  `spillover()` with a character budget (`previewChars`) — show an inline preview (the
  immediate answer), stage the full set on the canvas, return `canvas_id` + `table_name` +
  `spilled`. The preview is sized in characters of `JSON.stringify(row)`, not row count
  (occurrence rows vary widely). Target ≈25k tokens inline (`previewChars: 100_000`).
  `paleobiology_get_diversity` returns its full bin set inline (bounded); `paleobiology_search_collections`
  pages inline.
- **Canvas reuse replaces, never accumulates.** The staged table name is deterministic per
  canvas (`occurrences_<canvasId>`), and the framework's `registerTable` drops the table before
  recreating it. So passing a prior `canvas_id` back into `paleobiology_search_occurrences`
  **overwrites** that canvas's occurrence table with the new result — each search restages the
  full set, it does not append across calls. The `canvas_id` `.describe()` states this so an
  agent doesn't expect the workspace to grow by re-querying.
- **Truncation disclosure, driven by the real total.** Both list searches send `rowcount` and
  read `records_found`, so `ctx.enrich.total(n)` carries the upstream match count and the
  partial-set disclosure names the exact remainder. Collections are truncated when
  `offset + shown < records_found` — the page-filled heuristic it replaces falsely flagged a
  final page that happened to fill `limit`. Occurrences page on the same arithmetic and name
  the next offset (`Showing occurrences N–M of TOTAL. Advance offset to M for the next page.`)
  via `ctx.enrich.notice(...)`; the "raise limit" hint is appended only when `limit` — not the
  server-wide cap — is the binding constraint and there is headroom below 500, so it can never
  fire at the maximum. Both reach `structuredContent` and `content[]`, so neither client
  surface treats a slice as complete.
- **An empty page past the end is a paging fault, not a filter fault.** Both list searches
  detect `offset >= records_found` on a zero-row page and say so (`Offset N is past the end of
  the TOTAL matching …`) instead of advising the agent to widen filters that did match.
- **The child list is a page, and says so.** `show_children` pulls at most 200 immediate
  children per call. PBDB's `taxa/list` reports `records_found` as min(limit, true_total) —
  unlike `occs/list`/`colls/list`, where it is the real, paging-independent count — so
  `rowcount` cannot disclose a clipped child list, and the exact total costs a second
  `limit=0` request on every call. The service over-fetches ONE row instead: 201 requested,
  the extra dropped, `children_truncated` set when it came back. That keeps `show_children` at
  one upstream request while `children_truncated` + `children_offset` give the agent both the
  disclosure and the path to the rest — an exact child count it does not need in order to page.
- **Warnings ride the success path.** PBDB answers HTTP 200 with `warnings[]` when it could
  not apply part of a query — and for an unrecognized `lithology` it returns the FULL
  UNFILTERED set, so a dropped warning reads as a genuine match. `parseEnvelope` carries
  `warnings[]` out alongside the records (`errors[]` stays a thrown NotFound — it arrives
  *instead of* a result, warnings *alongside* one), and the three list searches compose them
  into their `notice` enrichment. This is also what separates an unmatched taxon name from a
  valid query with zero overlap: both return zero rows, only the warning tells them apart.
- **`format()` parity.** Each tool's `format()` renders every output field as structured
  markdown (interval + Ma, modern + paleo coords, formation, accepted vs identified name) so
  `content[]`-only clients (Claude Desktop) see the same data as `structuredContent` clients
  (Claude Code). Agent-facing context (empty-result notices, the parsed filter, totals,
  attribution) goes in the `enrichment` block, not hand-authored into `format()` text.
- **Preserve uncertainty; never fabricate.** PBDB sparsely populates paleo-coords,
  `late_interval`, `formation`, `lithology`, and `environment`. The normalizer leaves them
  absent (not zero/empty-string defaults) and `format()` omits them rather than inventing — a
  missing paleo-coordinate is "unknown", not "0,0". Required-vs-optional in the output schema
  is set against this real sparsity (every geology/paleo field is optional).
- **Provenance.** Each occurrence/collection row carries its `reference_no`; the response
  enrichment carries the CC-BY attribution string. The agent can cite the source.

---

## Error Contract

The read tools mostly let the framework's auto-classification handle failures (a PBDB 5xx →
`ServiceUnavailable`, a malformed bbox → `ValidationError`). Two domain failure modes warrant
typed contract entries:

| Tool | `reason` | code | when | recovery |
|---|---|---|---|---|
| `paleobiology_get_taxon` | `taxon_not_found` | `NotFound` | Name/`taxon_no` resolves to no PBDB taxon. | "If searching by name: check the spelling or try a higher rank (genus → family). If searching by taxon_no: re-run `paleobiology_get_taxon` by name to obtain a valid integer." |
| `paleobiology_list_intervals` | `interval_not_found` | `NotFound` | A named interval is in neither the bundled international scale (after any `level`/Ma filters) nor a PBDB lookup across the other scales. | "Check the spelling, call `paleobiology_list_intervals` without a name to browse the international scale, or query by `min_ma`/`max_ma` instead." |
| `paleobiology_list_intervals` | `interval_lookup_unavailable` | `ServiceUnavailable` | The name is outside the bundled scale and PBDB could not be reached to check the others. Retryable. | "Retry in a moment; meanwhile any international-scale name still resolves offline, as does a `min_ma`/`max_ma` query." |
| `paleobiology_search_occurrences` / `_get_diversity` / `_search_collections` | `conflicting_taxon_filter` | `InvalidParams` | Both `base_name` and `base_id` were supplied. | "Send `base_id` alone when the taxon id is already resolved, or `base_name` alone when working from a name." |
| `paleobiology_get_diversity` | `missing_filter` | `InvalidParams` | Neither `base_name` nor `base_id` was supplied. | "Provide a clade-inclusive `base_name`, or a `base_id` resolved with `paleobiology_get_taxon`." |
| `paleobiology_dataframe_query` / `_describe` / `_drop` | `canvas_disabled` | `ServiceUnavailable` | `CANVAS_PROVIDER_TYPE` is not `duckdb`, so no canvas exists. | "Set `CANVAS_PROVIDER_TYPE=duckdb` (and install `@duckdb/node-api`) to enable SQL over staged results." |

(`paleobiology_dataframe_query` additionally surfaces the canvas layer's own `missing_table` /
`invalid_sql` errors — re-stage the data or fix the named column, respectively — but those are
raised by the framework's canvas primitive, not declared here.)

Beyond the boundary guards above (plus each search's `missing_filter` / `incomplete_bbox` /
`inverted_ma_range`), the search tools declare no domain contract — an empty result is a valid
empty list with an `enrichment` notice, not an error, and upstream failures are covered by
baseline classification.

---

## Known Limitations

- **PBDB taxonomy is opinionated** and can differ from GBIF's backbone — names won't always
  reconcile 1:1 in the cross-domain pairing. The `identified_name` vs `accepted_name` split
  surfaces this, but an agent comparing the two databases must reconcile manually.
- **Paleo-coordinates are model-dependent.** They come from a plate-tectonic reconstruction
  (`paleomodel`, e.g. `gplates`); different models place a point differently. The output
  carries the model name so the figure isn't treated as ground truth.
- **Sparse fields are the norm,** not the exception. Many occurrences lack paleo-coords,
  formation, or a `late_interval`; many collections lack lithology or environment. Coverage is
  uneven across taxa, time, and geography (well-studied clades and regions dominate).
- **Sampling bias is inherent to the fossil record.** Diversity counts reflect *sampled*
  diversity, skewed by collection effort, rock availability, and research attention — not true
  past diversity. The tool returns sampled-in-bin + range-through counts; interpretation is
  the agent's.
- **The bundled time scale lags ICS revisions** until the snapshot is regenerated. Document
  the snapshot's ICS version; refresh on ICS updates.
- **Per-page cap.** A single occurrence pull caps at `PBDB_MAX_OCCURRENCES`; very large clades
  over long intervals exceed it in one call, and the response says which rows the page covers
  against `records_found` and which offset reaches the next. Page through with `limit`/`offset`,
  narrow the filter, or query the staged canvas. Collections page inline the same way under the
  same cap — no canvas, so very dense locality searches are paged through, not staged.
- **The exact immediate-child count is not available.** `show_children` discloses whether more
  children remain, not how many — PBDB's `taxa/list` has no paging-independent total, and the
  only source of one is an extra request per call. Page with `children_offset` until
  `children_truncated` is false to enumerate them.
- **No canvas on Cloudflare Workers.** DuckDB has no V8-isolate build, so the spill path and
  `dataframe_*` tools are unavailable on a Workers deployment (the search tools still return
  inline previews). Node/Bun only for the analytical surface.

---

## v1 Scope vs. Deferred

**Ships in v1**

- 5 domain tools: `paleobiology_search_occurrences`, `paleobiology_get_taxon`,
  `paleobiology_get_diversity`, `paleobiology_list_intervals`,
  `paleobiology_search_collections`.
- The standardized 3-tool DataCanvas set: `paleobiology_dataframe_query` +
  `paleobiology_dataframe_describe` (always registered) and `paleobiology_dataframe_drop`
  (opt-in via `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED`, default off).
- 2 resources: `paleobiology://occurrence/{occurrence_no}`,
  `paleobiology://taxon/{taxon_no}`.
- `vocab=pbdb` normalization; modern + paleo coords; named-interval ↔ Ma echoing; bundled ICS
  time-scale snapshot; CC-BY attribution; DataCanvas spill for `paleobiology_search_occurrences`
  only (diversity + collections return inline per the earns-its-keep gate); graceful
  degradation when canvas is disabled.

**Deferred**

- A `fossil_vs_living` **prompt** scaffolding the GBIF cross-domain comparison (Workflow #4).
- `macrostrat` integration (rock units / geologic column for a locality) — a separate future
  server idea.md names.
- `MirrorService`-backed local PBDB mirror — only if live-query latency or rate-limit pressure
  proves it's needed (PBDB is responsive today; not warranted yet).
- Paleo-map image rendering / static-asset map tiles — out of scope; we return paleo-coords as
  numbers.
- Specimen-level / measurement data, references/bibliography tools, and `/strata/list` as its
  own tool (strata are surfaced inline on collections in v1) — additive later if demand
  warrants.
- An optional `nameContains` MCP-side filter on intervals — the snapshot is small and
  `paleobiology_list_intervals` already filters by name/Ma/level; not needed in v1.
