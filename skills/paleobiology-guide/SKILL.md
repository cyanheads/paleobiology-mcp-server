---
name: paleobiology-guide
description: Use paleobiology_* tools to investigate fossil assemblages, compare sampled diversity through geologic time, or aggregate staged occurrences. Follow taxon identity, filter-warning, coverage, and turnover gates before drawing conclusions.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Use the Paleobiology Database for recorded fossil occurrences, fossil localities, taxonomic ranges, and sampled diversity. It does not establish true historical abundance or reconstruct phylogenies. Living distributions require a separate source; reconcile names independently rather than carrying PBDB identifiers into another database.

## Identifiers

- `paleobiology_get_taxon` returns the matched record's `taxon_no` and its accepted identity separately. Use `accepted_no` for accepted-clade searches; retain the matched identifier when discussing the queried record. A status does not necessarily mean synonymy.
- Occurrence rows supply `occurrence_no`, accepted taxon `accepted_no`, and, when recorded, `collection_no` and `reference_no`. Collections also supply collection and reference identifiers. Use these returned integers rather than guessing IDs from names.
- `paleobiology_search_occurrences` issues `canvas_id` and a table name when staging succeeds. These identify temporary analytical data, not PBDB records.

## Gates

- Read filter-warning notices before treating a result as evidence for the requested scope. PBDB can return rows while ignoring an unrecognized selector; correct the selector before drawing a filtered conclusion.
- Check page and staged coverage before reporting an aggregate as the whole match set. Inline rows and staged rows can cover different amounts of data. A table capped at 50,000 occurrences is partial when more matches exist.
- Interpret diversity originations and extinctions as first and last appearances in the selected data. Inspect boundary notices: the oldest and youngest bins can reflect truncated ranges. Extant-range extension is opt-in (`recent` defaults to false); enabling it does not remove other selection-boundary effects.
- Before calling a taxon extinct, distinguish its sampled last appearance from a biological extinction event and inspect its extant status. Before comparing richness, hold taxonomic rank, time bins, and geographic/environmental selection consistent.
- Use stored formation names. Pass their spelling, lists, and wildcard expressions unchanged; do not automatically strip “Formation”, “Group”, “Member”, or abbreviations. A zero match can reflect a name mismatch rather than an empty fauna.
- Do not equate an empty page beyond the reported total with absence. Follow paging guidance and examine the actual filtered match set. Missing classification is unknown, not a separate taxon or evidence that a rank is absent.

## Core chain

Resolve the lineage with `paleobiology_get_taxon`, inspect the matched and accepted identities, then carry the accepted identifier into the relevant clade search. Ground unfamiliar interval names with `paleobiology_list_intervals`. Choose occurrences for specimen-set records and their spatial/stratigraphic context; choose `paleobiology_get_diversity` for PBDB's binned sampled-taxon series.

## Workflows

**Locality and fauna.** Find localities with `paleobiology_search_collections`, then investigate an individual collection through `paleobiology_search_occurrences`. For an entire named formation's assemblage, search occurrences by formation directly rather than treating one locality as representative. Keep collection counts, occurrence counts, and distinct accepted-taxon counts separate.

**Time windows.** Interval lookup returns intervals with positive-duration overlap for a nonzero-width window; an explicit point query includes intervals meeting at that point. Do not turn a boundary lookup into an extra full stage in an analysis. Preserve the returned interval source and snapshot version when citing chronology.

**Canvas analysis.** A first occurrence page with further matches can stage up to 50,000 matching rows from the beginning of the same filtered set. The inline page remains the requested page; later-offset and complete-page calls do not acquire another whole set. If optional staging is unavailable, use the disclosed inline page and pagination rather than assuming a usable canvas exists.

Call `paleobiology_dataframe_describe` with the returned `canvas_id` for table and column names before writing SQL, then `paleobiology_dataframe_query` with a read-only query. Passing the same `canvas_id` to another staging search replaces its occurrence table; it does not append or preserve a second result beside it. The table expires with the canvas, so reacquire the source data after expiry.

Use the described JSON classification column for rank rollups, keeping missing ranks visible as unknown. Counting occurrence rows measures recorded occurrences; counting distinct accepted identifiers measures distinct recorded taxa, not PBDB's diversity estimator. When query results are truncated, use a count query for the exact cardinality and a stable order with SQL pagination to retrieve rows.

**Citations.** Collect distinct reference identifiers from the evidence rows and resolve them with `paleobiology_get_references`. Each call attempts the first 500 distinct IDs; continue with `remaining_reference_nos` until exhausted, and retain `not_found` separately from unattempted identifiers. Cite the resolved publications for claims they support, alongside the Paleobiology Database attribution.
