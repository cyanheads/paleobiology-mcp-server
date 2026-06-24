# paleobiology-mcp-server — Idea & Design

The deep-time counterpart to `gbif` — fossil biodiversity over the [Paleobiology Database](https://paleobiodb.org) (PBDB), a community-curated record of where and when life existed across ~540 million years. Fossil occurrences filtered by clade, geologic interval, and geography; taxon fossil ranges (first/last appearance); diversity-through-time curves; and the geologic time scale itself. Keyless, CC BY.

The fleet covers living biodiversity (`gbif`), genomes (`ensembl`), and a future fossil gap right here. `gbif` answers "where does this species live *now*"; this answers "where and *when* did this clade live, and when did it go extinct." The pairing is the headline cross-domain story: modern + fossil occurrences of one lineage across the whole of time.

**Audience:** Paleontologists, macroevolution and biogeography researchers, geologists, educators, museum/science communicators, and agents answering "when did T. rex live" or "plot ammonite diversity through the Mesozoic."

## User Goals

- Find fossil occurrences of a taxon ("where and when did Tyrannosaurus live?")
- Map occurrences in a region and/or geologic interval
- Get a taxon's fossil temporal range — first appearance, last appearance, extinction
- Plot biodiversity (or extinction/origination) through time for a clade
- Look up geologic time intervals and their absolute-age boundaries (Ma)
- Find fossil collections/localities and the strata they come from

## API Surface

One provider at `paleobiodb.org/data1.2/`. Queries combine **taxonomic** (taxon name or `taxon_no`), **temporal** (interval name like `Cretaceous`, or a `max_ma`/`min_ma` range), and **spatial** (lat/lng bbox) filters. Occurrences key on `occurrence_no`; taxa on `taxon_no`; intervals are named with absolute boundaries in millions of years (Ma). Responses use compact field codes by default — the `show` parameter expands blocks (`coords`, `class`, `time`, `strat`, `loc`).

| Resource | Endpoint | Purpose |
|:---------|:---------|:--------|
| Occurrences | `/occs/list`, `/occs/single` | Fossil occurrences by taxon / interval / bbox |
| Taxa | `/taxa/list`, `/taxa/single` | Taxonomy + fossil range, parents/children |
| Diversity | `/occs/diversity`, `/occs/prevalence` | Diversity / origination / extinction through time |
| Intervals | `/intervals/list`, `/scales` | Geologic time scale (eon→age) with Ma boundaries |
| Collections | `/colls/list` | Fossil localities (a collection groups co-occurring fossils) |
| Strata | `/strata/list` | Stratigraphic / formation units |

Note **paleo-coordinates**: occurrences carry both modern lat/lng and the paleo-position (where the continent was at the time) — a distinction worth surfacing, since "where it is now" ≠ "where it lived."

## Tool Surface (sketch)

```
paleobiology_search_occurrences — fossil occurrences filtered by taxon, geologic interval
                                 (named or Ma range), geographic bbox, and environment.
                                 Returns per occurrence: accepted taxon name + rank, age
                                 (Ma range + interval name), modern AND paleo lat/lng,
                                 geologic formation, and collection ref. The flagship;
                                 large result sets spill to DataCanvas for SQL over the
                                 set (count by interval, map by region).

paleobiology_get_taxon          — taxonomic record + fossil temporal range by name or
                                 taxon_no: accepted name, rank, full classification,
                                 parent and immediate children, occurrence count, and
                                 first/last appearance (FAD/LAD) in Ma. "When did this
                                 clade exist, and what's inside it." Resolves names for
                                 the occurrence/diversity tools.

paleobiology_get_diversity      — diversity through time for a clade over an interval:
                                 counts of taxa (and origination/extinction) per geologic
                                 bin. The analytical tool — answers "plot dinosaur genus
                                 diversity across the Mesozoic." DataCanvas-friendly time
                                 series; resolution selectable (period/epoch/age).

paleobiology_list_intervals     — the geologic time scale: eons, eras, periods, epochs,
                                 and ages with their absolute-age boundaries (Ma) and
                                 nesting. Reference lookup that grounds every temporal
                                 filter and lets an agent translate "Late Cretaceous" ↔
                                 "100.5–66.0 Ma". Largely static — bundle-able.

paleobiology_search_collections — fossil collections (localities) by area + interval:
                                 location, age, formation/strata, lithology, depositional
                                 environment, and the taxa found together. The "what's
                                 been dug up here, and from what rock" view; pairs strata
                                 with the fauna for paleoenvironment questions.
```

## Design Notes

- **Compact field codes are the main implementation gotcha.** PBDB returns terse codes (`tna`, `oei`, `lng`) unless you pass `show` blocks; the service layer must request the right blocks per tool and map them to readable field names — never pass the raw codes through to the agent.
- **Surface both coordinate systems.** Modern lat/lng (for mapping today) and paleo-coordinates (where the landmass sat at the time) answer different questions; label them so an agent doesn't plot a Triassic occurrence on a modern coastline and conclude something false.
- **Geologic time is the native temporal axis** — accept both named intervals (`Jurassic`, `Maastrichtian`) and Ma ranges, and always echo both in output. `list_intervals` is the rosetta stone; consider bundling the time-scale table as a static asset since it changes rarely (ICS updates) and grounds every other tool offline.
- **Diversity and large occurrence pulls are analytical** → DataCanvas + `paleobiology_dataframe_query` (count by interval, group by clade, filter by region). Diversity curves are inherently a time series an agent will want to aggregate.
- **The GBIF pairing is the demo.** Same query intent ("genus *Panthera*") across `gbif` (extant occurrences) and this server (fossil occurrences) = a lineage through all of time. Document the cross-link explicitly; it's the most compelling CROSS-DOMAIN entry this server enables, and both share GBIF-backbone-style taxonomy so names line up.
- **Taxonomy is opinionated** — PBDB has its own accepted-name resolution and synonymy. Surface the accepted name + the original identification, and note that PBDB taxonomy can differ from GBIF's backbone (a reconciliation an agent comparing the two must be aware of).
- **Prefix choice:** repo name `paleobiology-mcp-server` → `paleobiology_` prefix (canonical, self-descriptive, per the naming skill). `pbdb_` is the brand acronym but reads as obscure outside the field; revisit at scaffold time if a tighter surface is wanted.
- **Composes with** `gbif` (living counterpart), `wikipedia` (clade background/imagery), `openstreetmap` (geocode a place → bbox), and a future `macrostrat` server (rock units / geologic column for the same locality).
- README one-liner: "Fossil biodiversity over the Paleobiology Database — occurrences, taxon ranges, and diversity through 540 million years of deep time."
