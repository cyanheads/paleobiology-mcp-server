<div align="center">
  <h1>@cyanheads/paleobiology-mcp-server</h1>
  <p><b>Search fossil occurrences, resolve taxon fossil ranges, plot diversity through deep time, and look up the geologic time scale via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/paleobiology-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/paleobiology-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/paleobiology-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Fossil biodiversity over the Paleobiology Database (PBDB), spanning roughly 540 million years. Resolve taxon fossil ranges, search fossil occurrences and collections by taxon, geologic time, and location, and plot diversity through deep time from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `paleobiology_search_occurrences` | Search fossil occurrences by taxon, geologic time, geography, and depositional environment. Every row carries both modern and paleo coordinates; broad results spill to a DataCanvas for SQL. |
| `paleobiology_get_taxon` | Resolve a taxon by name or `taxon_no` to its accepted name, rank, classification, and FAD/LAD range — the name-resolution gateway. |
| `paleobiology_get_diversity` | Compute a diversity / origination / extinction curve for a clade across geologic time. |
| `paleobiology_list_intervals` | Look up the geologic time scale — named intervals ↔ absolute Ma boundaries. |
| `paleobiology_search_collections` | Find fossil collections (localities) by area, geologic time, formation, and lithology. |
| `paleobiology_dataframe_query` | Run a read-only SQL `SELECT` over occurrence sets staged on a DataCanvas. |
| `paleobiology_dataframe_describe` | List the tables and columns staged on a DataCanvas. |
| `paleobiology_dataframe_drop` | Drop a single staged table to free memory before its TTL expires. Opt-in. |

### Resources

| Resource | Description |
|:---|:---|
| `paleobiology://occurrence/{occurrence_no}` | One fossil occurrence with full detail — modern + paleo coordinates, classification, strata, locality. |
| `paleobiology://taxon/{taxon_no}` | One taxon record with its fossil range and classification. |

All resource data is also reachable via tools — the resources mirror a single-record read of `paleobiology_search_occurrences` / `paleobiology_get_taxon` for clients that surface resources. Tool-only clients lose nothing.

---

## Capability reference

### `paleobiology_search_occurrences` <sub>tool</sub>

- `base_name` (a clade and all its descendants) or `taxon_name` (exact) filters the taxon; `base_id` filters the same clade by its resolved PBDB `taxon_no` instead of a name — exactly one of `base_name`/`base_id`, never both
- Age by a named `interval` or a `max_ma`/`min_ma` range (`min_ma` strictly less than `max_ma`), plus an optional lng/lat bounding box (`lngmin`/`lngmax` both or neither; a lone `latmin`/`latmax` is valid) and `environment` (`marine`, `terrestrial`, `freshwater`); `collection_no` scopes to one locality. At least one filter is required
- Every row carries both **modern** lng/lat (where the rock is today) and **paleo** lng/lat (where the landmass sat at deposition), plus formation, age interval, and higher classification (phylum–genus)
- `limit` (max 500, default 100) and `offset` page against PBDB's true match count; the response names the exact offset for the next page
- Broad results spill to a DataCanvas — `canvas_id` and `table_name` return only when the page spills; reusing a `canvas_id` replaces that canvas's occurrence table rather than accumulating
- Typed errors: `missing_filter`, `conflicting_taxon_filter`, `incomplete_bbox`, `inverted_ma_range` — all rejected at the tool boundary before the upstream request

---

### `paleobiology_get_taxon` <sub>tool</sub>

- Resolve by `name` or `taxon_no` (exactly one required) to accepted name, rank, higher classification, immediate parent, occurrence count, and FAD/LAD range in Ma
- The returned `taxon_no` is the `base_id` accepted by `paleobiology_search_occurrences`, `paleobiology_get_diversity`, and `paleobiology_search_collections`
- `show_children` pages immediate child taxa, up to 200 per call; `children_truncated` and `children_offset` say whether and where to continue
- PBDB taxonomy can differ from GBIF's backbone — the accepted name may differ from the searched name
- Typed errors: `taxon_not_found`, `missing_selector`

---

### `paleobiology_get_diversity` <sub>tool</sub>

- Clade by `base_name` or `base_id` (exactly one required), bounded by a named `interval` or `max_ma`/`min_ma` range (`min_ma` strictly less than `max_ma`)
- `count` enum: `genera` (default), `species`, `families`; `resolution` enum: `period` (default), `epoch`, `age`
- Returns the full bin set inline, oldest-first, each bin carrying sampled/implied/origination/extinction/range-through counts and occurrence totals
- Counts reflect **sampled** diversity, biased by collection effort and rock availability — not true past diversity
- Typed errors: `missing_filter`, `conflicting_taxon_filter`, `inverted_ma_range`

---

### `paleobiology_list_intervals` <sub>tool</sub>

- Filter by a case-insensitive `name` substring, a `min_ma`/`max_ma` overlap window, and/or a `level` (`eon`, `era`, `period`, `epoch`, `age`); no filters browses the full scale
- Every name on the bundled ICS international-scale snapshot resolves offline; a name outside it (sub-stage/regional names like "Late Maastrichtian") costs one PBDB lookup, and the response's `source` field (`bundled_ics` / `pbdb_upstream`) plus `snapshot_version` say which answered
- Each interval returns its `level`, Ma boundaries, `parent_no`, and — when resolved upstream — the originating `scale` name
- Typed errors: `interval_not_found` (name matched nothing anywhere), `interval_lookup_unavailable` (retryable — PBDB unreachable for a non-bundled name)

---

### `paleobiology_search_collections` <sub>tool</sub>

- Filter by `base_name`/`base_id` (mutually exclusive), a named `interval` or `max_ma`/`min_ma` range, a lng/lat bounding box, a `formation` or `lithology` name, and/or `environment`; at least one filter is required
- Each locality returns modern lng/lat, age (named interval and Ma), formation/group/member, lithology, depositional environment, and co-occurring-fossils count (`n_occs`)
- `limit` (max 500, default 100) and `offset` page results; the response discloses when localities remain
- Take a `collection_no` into `paleobiology_search_occurrences` to see the fauna found at that locality
- Typed errors: `missing_filter`, `conflicting_taxon_filter`, `incomplete_bbox`, `inverted_ma_range`

---

### `paleobiology_dataframe_query` <sub>tool</sub>

- Runs a read-only SQL `SELECT` against occurrence sets staged on a DataCanvas by `paleobiology_search_occurrences`; writes and file-reading functions are rejected
- Reference tables by the `table_name` a spilled search returned; the `classification` column is JSON — roll up by rank with `json_extract_string(classification, '$.family')` (also `$.phylum`, `$.class`, `$.order`, `$.genus`)
- Output caps at the canvas row limit; `truncated: true` marks a trimmed result
- Typed error: `canvas_disabled` when `CANVAS_PROVIDER_TYPE` is not `duckdb`

---

### `paleobiology_dataframe_describe` <sub>tool</sub>

- Lists the tables staged on a canvas, each with its row count and column names/types/nullability — call before `paleobiology_dataframe_query` to discover identifiers
- Typed error: `canvas_disabled` when `CANVAS_PROVIDER_TYPE` is not `duckdb`

---

### `paleobiology_dataframe_drop` <sub>tool</sub>

- Drops one staged table by `canvas_id` + `table_name` to free memory before its TTL expires; dropping a nonexistent table returns `dropped: false`, not an error
- Opt-in — registered only when `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true`, absent from `tools/list` otherwise
- Typed error: `canvas_disabled` when `CANVAS_PROVIDER_TYPE` is not `duckdb`

---

### `paleobiology://occurrence/{occurrence_no}` <sub>resource</sub>

- Path param `occurrence_no` is a bare positive integer (regex-validated), from `paleobiology_search_occurrences` output
- Returns the same full occurrence detail as the tool — accepted/identified names, age, modern + paleo coordinates, formation/strata, locality — plus a CC BY 4.0 `attribution` field
- Typed error: `occurrence_not_found`

---

### `paleobiology://taxon/{taxon_no}` <sub>resource</sub>

- Path param `taxon_no` is a bare positive integer (regex-validated), from `paleobiology_get_taxon` or an occurrence's `accepted_no`
- Mirrors `paleobiology_get_taxon`'s shape exactly — accepted name, rank, classification, parent, FAD/LAD range — plus a CC BY 4.0 `attribution` field
- Typed error: `taxon_not_found`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PBDB-specific:

- Type-safe client for the Paleobiology Database (PBDB) REST API, requesting `vocab=pbdb` so readable field names come straight from upstream instead of hand-mapped terse codes
- Bundled ICS geologic time-scale snapshot — `paleobiology_list_intervals` resolves the international scale's named intervals ↔ absolute Ma boundaries with no network call, falling back to a PBDB lookup for sub-stage and regional names
- DataCanvas spill for broad occurrence queries: an inline preview plus a staged table queryable with read-only SQL (count by interval, group by formation/country, roll up by family from the `classification` JSON column)
- No auth, no API key — PBDB is fully open (`MCP_AUTH_MODE` defaults to `none`)

Agent-friendly output:

- Two coordinate systems on every occurrence — modern lng/lat and paleo lng/lat, distinctly labeled, so an agent never plots a deep-time fossil on a modern coastline
- Both temporal representations on every age — the named interval **and** its Ma boundaries
- Provenance and honesty — every row carries its `reference_no`, every PBDB-backed tool and resource carries the CC BY attribution, sparse upstream fields (paleo-coords, formation, `late_interval`) are omitted rather than zeroed, and diversity counts are flagged as sampled

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://paleobiology.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "paleobiology-mcp-server": {
      "type": "streamable-http",
      "url": "https://paleobiology.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add one of the following to your MCP client configuration file. PBDB is keyless — no API key required.

With bunx:

```json
{
  "mcpServers": {
    "paleobiology-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/paleobiology-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "paleobiology-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/paleobiology-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "paleobiology-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/paleobiology-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

To enable SQL over large occurrence sets, set `CANVAS_PROVIDER_TYPE=duckdb` (the `@duckdb/node-api` peer dep ships in `dependencies`). Without it, `paleobiology_search_occurrences` still returns its inline preview; the `paleobiology_dataframe_*` tools fail with a clear "canvas disabled" message.

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+).
- No API key — the Paleobiology Database is fully open.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/paleobiology-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd paleobiology-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override defaults — all vars are optional
```

## Configuration

All variables are optional — the server runs with no configuration against the public PBDB API.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `PBDB_BASE_URL` | Paleobiology Database API base. Override for a mirror/proxy or pinned API version. | `https://paleobiodb.org/data1.2` |
| `PBDB_TIMEOUT_MS` | Per-request timeout in milliseconds. Diversity queries over large clades can be slow. | `30000` |
| `PBDB_MAX_OCCURRENCES` | Hard cap on rows pulled per occurrence/collection call. | `1000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable the DataCanvas spill path and `paleobiology_dataframe_*` tools. | `none` |
| `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED` | Register `paleobiology_dataframe_drop`. Absent from `tools/list` when unset. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateless`, `stateful`, or `auto`. The server declares `stateless` in `src/index.ts` — it holds no per-session state — and this variable overrides that declaration. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t paleobiology-mcp-server .
docker run --rm -p 3010:3010 paleobiology-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/paleobiology-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
