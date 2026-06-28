# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Taxon resource now returns FAD/LAD at the top level (breaking — was wrapped in range{}), matching paleobiology_get_taxon; diversity bins ordered oldest-first; always-present taxon and diversity-bin fields marked required.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Initial release — fossil occurrences, taxon ranges, diversity through deep time, the geologic time scale, and fossil localities over the Paleobiology Database (PBDB), with optional DataCanvas SQL over staged occurrence sets.
