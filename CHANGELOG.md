# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-07-30

search_occurrences gains offset paging with exact next-page notices; search_occurrences, search_collections, and get_diversity accept base_id as a clade filter alongside base_name; get_taxon's show_children pages past 200 with children_offset/children_truncated.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-30

search_occurrences, search_collections, and get_diversity surface PBDB's warnings[] instead of discarding them; both list searches send rowcount so totalCount and truncation reflect the true upstream match count rather than a page-filled guess.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-30

search_occurrences, search_collections, and get_diversity reject invalid bounding boxes and inverted Ma ranges before querying PBDB; occurrence rows and get_taxon gain classification and CC BY attribution; canvas_id is returned only on an actual spill; list_intervals sorts filtered results oldest-first.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-06-28

paleobiology_search_occurrences gains a collection_no drilldown filter (PBDB coll_id); the DataCanvas spill now discloses a capped page honestly instead of claiming the full set; and both search tools reject filterless calls with a typed missing_filter error before any PBDB request.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Taxon resource now returns FAD/LAD at the top level (breaking — was wrapped in range{}), matching paleobiology_get_taxon; diversity bins ordered oldest-first; always-present taxon and diversity-bin fields marked required.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Initial release — fossil occurrences, taxon ranges, diversity through deep time, the geologic time scale, and fossil localities over the Paleobiology Database (PBDB), with optional DataCanvas SQL over staged occurrence sets.
