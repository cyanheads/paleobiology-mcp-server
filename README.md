<div align="center">
  <h1>@cyanheads/paleobiology-mcp-server</h1>
  <p><b>Search fossil occurrences, resolve taxon fossil ranges, plot diversity through deep time, and look up the geologic time scale via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 3 Data Resources • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/paleobiology-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/paleobiology-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/paleobiology-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/paleobiology-mcp-server/releases/latest/download/paleobiology-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=paleobiology-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGFsZW9iaW9sb2d5LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22paleobiology-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpaleobiology-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://paleobiology.caseyjhand.com/mcp](https://paleobiology.caseyjhand.com/mcp)

</div>

---

## Overview

Fossil biodiversity over the Paleobiology Database (PBDB), spanning roughly 540 million years. Resolve taxon fossil ranges, search fossil occurrences and collections by taxon, geologic time, and location, and plot diversity through deep time.

### Tools

| Tool | Description |
|:---|:---|
| `paleobiology_search_occurrences` | Search fossil occurrences by taxon, geologic time, geography, and depositional environment. Every row carries both modern and paleo coordinates; with DataCanvas on, broad results spill to a canvas for SQL. |
| `paleobiology_get_taxon` | Resolve a taxon by name or `taxon_no` to matched and accepted identities, status, classification, and FAD/LAD range. |
| `paleobiology_get_diversity` | Compute a diversity / origination / extinction curve for a clade across geologic time. |
| `paleobiology_list_intervals` | Look up the geologic time scale — named intervals ↔ absolute Ma boundaries. |
| `paleobiology_search_collections` | Find fossil collections (localities) by area, geologic time, formation, and lithology. |
| `paleobiology_get_references` | Resolve the `reference_no` on occurrence and collection rows to full citations — authors, year, title, publication, pages, DOI. |
| `paleobiology_dataframe_query` | Run a read-only SQL `SELECT` over occurrence sets staged on a DataCanvas. Listed only when DataCanvas is on. |
| `paleobiology_dataframe_describe` | List the tables and columns staged on a DataCanvas. Listed only when DataCanvas is on. |
| `paleobiology_dataframe_drop` | Drop a single staged table to free memory before its TTL expires. Opt-in; also needs DataCanvas. |

### Resources

| Resource | Description |
|:---|:---|
| `paleobiology://occurrence/{occurrence_no}` | One fossil occurrence with full detail — modern + paleo coordinates, classification, strata, locality. |
| `paleobiology://taxon/{taxon_no}` | One taxon record with its fossil range and classification. |
| `paleobiology://reference/{reference_no}` | One bibliographic reference — the formatted citation plus its structured fields. |

All resource data is also reachable via tools — the resources mirror a single-record read of `paleobiology_search_occurrences` / `paleobiology_get_taxon` / `paleobiology_get_references` for clients that surface resources. Tool-only clients lose nothing.

---

## Capability reference

### `paleobiology_search_occurrences` <sub>tool</sub>

- Requires at least one taxon, time, geographic, formation, environment, or `collection_no` filter. Use `base_name` or `base_id` for a clade, `taxon_name` for an exact match; page with `limit` (default 100, maximum 10,000, subject to `PBDB_MAX_OCCURRENCES`) and `offset`. Every served row appears on both response surfaces
- Returns modern and paleo coordinates, named intervals and Ma ages, strata, and higher classification, with `totalCount` for PBDB's true match count. Errors: `missing_filter`, `conflicting_taxon_filter`, `incomplete_bbox`, `inverted_ma_range`, and `pbdb_invalid_parameter` (with PBDB's reason) for a value PBDB cannot use
- With DataCanvas on, a first page with further matches fetches and stages up to 50,000 matching occurrences from offset zero. The requested page stays inline; the notice reports staged versus total coverage. Later pages and complete pages stage nothing. Use `canvas_id` + `table_name` with `paleobiology_dataframe_describe`, then SQL. Reusing a canvas atomically replaces its occurrence table. At the canvas cap, reuse an existing canvas or narrow the matching set
- Optional staging shares a 55-second deadline with the page request. A transient staging-fetch failure returns the valid inline page with an unavailable notice; caller cancellation propagates

---

### `paleobiology_get_taxon` <sub>tool</sub>

- Resolve by `name` or `taxon_no` to the matched record's name, rank, classification, parent, occurrence count, and FAD/LAD range in Ma. Accepted identity (`accepted_no`, `accepted_name`, `accepted_rank`) and PBDB's taxonomic status are separate; use `accepted_no` as `base_id` for an accepted-clade search
- `show_children` adds up to 200 immediate child taxa per call; `children_truncated` and `children_offset` say whether and where to continue
- Typed errors: `taxon_not_found`, `missing_selector`, `conflicting_selector` when both `name` and `taxon_no` are sent

---

### `paleobiology_get_diversity` <sub>tool</sub>

- Requires a clade (`base_name` or `base_id`), optionally bounded by time, `country`, `formation`, `environment`, or a geographic bounding box. Choose `count` (`genera`, `species`, `families`) and `resolution` (`period`, `epoch`, `age`); defaults are genera by period
- Returns the full bin set inline, oldest-first, with sampled, implied, origination, extinction, range-through, and occurrence counts
- Originations and extinctions are first/last appearances in the selected data, not established biological events. Notices identify possible truncation at the oldest and youngest bins. `recent: true` extends known extant ranges to the present; the default is `false`
- Typed errors: `missing_filter`, `conflicting_taxon_filter`, `incomplete_bbox`, `inverted_ma_range`, `pbdb_invalid_parameter` for a value PBDB cannot use (an unknown interval)

---

### `paleobiology_list_intervals` <sub>tool</sub>

- Filter by `name`, a `min_ma`/`max_ma` overlap window, or `level` (`eon`, `era`, `period`, `epoch`, `age`); omit filters to browse the bundled ICS scale. Nonzero and single-bound windows require positive-duration overlap; an explicit equal-bound point includes both intervals meeting there
- Returns interval rank, Ma boundaries, `parent_no`, and an upstream `scale` where available. `source` (`bundled_ics` / `pbdb_upstream`) and `snapshot_version` identify the source; names outside the snapshot use PBDB
- Typed errors: `interval_not_found` for an unmatched name; retryable `interval_lookup_unavailable` when PBDB cannot resolve a name outside the snapshot; `inverted_ma_range` when `max_ma` is below `min_ma`

---

### `paleobiology_search_collections` <sub>tool</sub>

- Requires at least one taxon, time, geographic, `country`, `formation`, `lithology`, or `environment` filter. Page with `limit` (default 100, maximum 10,000, subject to `PBDB_MAX_OCCURRENCES`) and `offset`. Every served row appears on both response surfaces
- Returns locality coordinates, age, strata, lithology, environment, and `n_occs`, with totals. Pass `collection_no` to `paleobiology_search_occurrences` for the fauna at that locality
- Typed errors: `missing_filter`, `conflicting_taxon_filter`, `incomplete_bbox`, `inverted_ma_range`, `pbdb_invalid_parameter` for a value PBDB cannot use (an unknown interval, or an unknown lithology sent as the only filter)

---

### `paleobiology_get_references` <sub>tool</sub>

- Pass a nonempty list of positive integer `reference_nos` from occurrence or collection rows; the first 500 distinct IDs resolve in one PBDB request, and the rest come back in `remaining_reference_nos` for the next call
- Returns references in request order: `citation`, `title`, and `publication` converted from PBDB HTML to plain text with one entity decode, plus `year`, `authors`, `editors`, `volume`, `issue`, pages, `publisher`, `language`, and `doi` where recorded
- Ids PBDB has no reference for land in `not_found` with a notice — a miss is a result, not an error

---

### `paleobiology_dataframe_query` <sub>tool</sub>

- Runs a read-only SQL `SELECT` against occurrence sets staged by `paleobiology_search_occurrences`, using the `table_name` it returned; writes and file-reading functions are rejected
- The `classification` column is JSON — roll up by rank with `json_extract_string(classification, '$.family')` (also `$.phylum`, `$.class`, `$.order`, `$.genus`)
- Returns every row supplied by the canvas query. `truncated: true` means `row_count` stopped at the framework's row cap; use a stable `ORDER BY` with SQL `LIMIT/OFFSET` to continue
- Listed only when DataCanvas is on (`CANVAS_PROVIDER_TYPE=duckdb`)

---

### `paleobiology_dataframe_describe` <sub>tool</sub>

- Lists the tables staged on a canvas, each with its row count and column names/types/nullability — call before `paleobiology_dataframe_query` to discover identifiers
- Listed only when DataCanvas is on (`CANVAS_PROVIDER_TYPE=duckdb`)

---

### `paleobiology_dataframe_drop` <sub>tool</sub>

- Drops one staged table by `canvas_id` + `table_name` to free memory before its TTL expires; dropping a nonexistent table returns `dropped: false`, not an error
- Opt-in — needs DataCanvas on and `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true`
- Typed error: `canvas_not_found` when the canvas has expired or never existed

---

### `paleobiology://occurrence/{occurrence_no}` <sub>resource</sub>

- Path param `occurrence_no` is a bare positive integer (regex-validated), from `paleobiology_search_occurrences` output
- Returns the same full occurrence detail as the tool — accepted/identified names, age, modern + paleo coordinates, formation/strata, locality — plus a CC BY 4.0 `attribution` field
- Typed error: `occurrence_not_found`

---

### `paleobiology://taxon/{taxon_no}` <sub>resource</sub>

- Path param `taxon_no` is a bare positive integer (regex-validated), from `paleobiology_get_taxon` or an occurrence's `accepted_no`
- Mirrors `paleobiology_get_taxon`'s shape exactly — matched and accepted identities, status, classification, parent, FAD/LAD range — plus a CC BY 4.0 `attribution` field
- Typed error: `taxon_not_found`

---

### `paleobiology://reference/{reference_no}` <sub>resource</sub>

- Path param `reference_no` is a bare positive integer (regex-validated), from an occurrence or collection row
- Returns the same record as one `paleobiology_get_references` entry plus a CC BY 4.0 `attribution` field
- Typed error: `reference_not_found`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PBDB-specific:

- Type-safe client for the Paleobiology Database (PBDB) REST API. Most endpoints use readable `vocab=pbdb`; taxon endpoints use compact records to preserve matched rank separately from accepted rank
- Bundled ICS geologic time-scale snapshot — `paleobiology_list_intervals` resolves the international scale's named intervals ↔ absolute Ma boundaries with no network call, falling back to a PBDB lookup for sub-stage and regional names
- DataCanvas spill for broad occurrence queries (on by default; `CANVAS_PROVIDER_TYPE=none` turns it off): an inline preview plus a staged table queryable with read-only SQL (count by interval, group by formation/country, roll up by family from the `classification` JSON column)
- No auth, no API key — PBDB is fully open (`MCP_AUTH_MODE` defaults to `none`)
- Diversity counts reflect sampling and collection effort, not true past diversity

Agent-friendly output:

- Two coordinate systems on every occurrence — modern lng/lat and paleo lng/lat, distinctly labeled, so an agent never plots a deep-time fossil on a modern coastline
- Both temporal representations on every age — the named interval **and** its Ma boundaries
- Provenance on every row: `reference_no` for `paleobiology_get_references`, plus CC BY attribution on tools and resources
- Sparse upstream fields (paleo-coords, formation, `late_interval`) are omitted rather than zeroed

Occurrence, collection, and diversity searches accept `country` as comma-separated two-letter country codes or PBDB continent codes, with leading `!` exclusion and `^` subtraction. Formation filters preserve PBDB's stored-name, list, and wildcard matching; do not automatically remove words such as “Formation” or “Member”.

The bundled [paleobiology-guide](./skills/paleobiology-guide/SKILL.md) covers identifier chaining, coverage checks, sampled turnover, and citation workflows. It ships with plugins, npm, Docker, and MCPB, and is served through MCP skill resources.

---

## Getting started

Connect to the hosted instance:

```sh
claude mcp add --transport http paleobiology-mcp-server https://paleobiology.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add paleobiology-mcp-server -- npx -y @cyanheads/paleobiology-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "paleobiology-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/paleobiology-mcp-server"]
    }
  }
}
```

PBDB is keyless. For Docker or a source build, see [Running the server](#running-the-server).

SQL over large occurrence sets is on by default (the `@duckdb/node-api` peer dep ships in `dependencies`). With `CANVAS_PROVIDER_TYPE=none`, `paleobiology_search_occurrences` still returns its complete requested page, and the `paleobiology_dataframe_*` tools are left off `tools/list` (the HTTP landing page shows them as disabled, with the setting that enables them).

## Configuration

All variables are optional — the server runs with no configuration against the public PBDB API.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `PBDB_BASE_URL` | Paleobiology Database API base. Override for a mirror/proxy or pinned API version. | `https://paleobiodb.org/data1.2` |
| `PBDB_TIMEOUT_MS` | Per-request timeout in milliseconds. Diversity queries over large clades can be slow. | `30000` |
| `PBDB_MAX_OCCURRENCES` | Cap on rows per inline occurrence/collection page. Separate from the 50,000-row staging bound. | `1000` |
| `CANVAS_PROVIDER_TYPE` | DataCanvas spill path and the `paleobiology_dataframe_*` tools. `none` disables both. | `duckdb` |
| `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED` | Enable `paleobiology_dataframe_drop` (DataCanvas must also be on). | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for traces and metrics. Logs require their own endpoint. | unset |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Enable OTLP log export to this exact URL. | unset |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results, with key-name redaction; secrets in free-form values remain. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | UTF-8 byte cap per logged payload. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4](https://bun.sh/) or higher (or Node.js v24+). No API key is required.

```sh
git clone https://github.com/cyanheads/paleobiology-mcp-server.git
cd paleobiology-mcp-server
bun install
cp .env.example .env # optional overrides
```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/paleobiology-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/paleobiology-mcp-server`. For stdio in an MCP client, use `"command": "docker"` and `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/paleobiology-mcp-server:latest"]`. Build locally with `docker build -t paleobiology-mcp-server .`; OpenTelemetry peers are installed unless built with `--build-arg OTEL_ENABLED=false`.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/pbdb` | Paleobiology Database HTTP client, normalization, and domain types. |
| `src/services/intervals` | In-memory index over the bundled ICS geologic time-scale snapshot. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields (a missing paleo-coordinate is "unknown", not `0,0`)

## Data attribution

Data is from the [Paleobiology Database](https://paleobiodb.org), licensed CC BY 4.0 — credit it in downstream use.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
