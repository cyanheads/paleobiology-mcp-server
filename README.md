<div align="center">
  <h1>@cyanheads/paleobiology-mcp-server</h1>
  <p><b>Search fossil occurrences, resolve taxon fossil ranges, plot diversity through deep time, and look up the geologic time scale via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/paleobiology-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/paleobiology-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/paleobiology-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/paleobiology-mcp-server/releases/latest/download/paleobiology-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=paleobiology-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGFsZW9iaW9sb2d5LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22paleobiology-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpaleobiology-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Eight tools (seven by default) — five domain tools for the Paleobiology Database, plus a DataCanvas trio for SQL over staged occurrence sets. Large occurrence results spill to a canvas; the other domain tools return inline.

| Tool Name | Description |
|:----------|:------------|
| `paleobiology_search_occurrences` | Search fossil occurrences by taxon, geologic time, geography, and depositional environment. Every row carries both modern and paleo coordinates. The flagship; broad results spill to a DataCanvas for SQL. |
| `paleobiology_get_taxon` | Resolve a taxon by name or `taxon_no` to its accepted name, rank, classification, parent, occurrence count, and first/last-appearance (FAD/LAD) range. Run first to resolve names for the other tools. |
| `paleobiology_get_diversity` | Compute a diversity / origination / extinction curve for a clade across geologic time, binned by period, epoch, or age. Returns the full bin set inline. |
| `paleobiology_list_intervals` | Look up the geologic time scale — eons through ages with absolute-age (Ma) boundaries and nesting. Translates named intervals ↔ Ma. Served from a bundled ICS snapshot; no network call. |
| `paleobiology_search_collections` | Find fossil collections (localities) by area and geologic time, with their formation, lithology, depositional environment, and co-occurring-fossils count. Paged inline. |
| `paleobiology_dataframe_query` | Run a read-only SQL `SELECT` over occurrence sets staged on a DataCanvas by `paleobiology_search_occurrences`. SELECT only. |
| `paleobiology_dataframe_describe` | List the tables and columns staged on a DataCanvas. Call before `paleobiology_dataframe_query` to discover table and column names. |
| `paleobiology_dataframe_drop` | Drop a single staged table to free memory before its TTL expires. Opt-in — registered only when `PALEOBIOLOGY_DATAFRAME_DROP_ENABLED=true`. |

---

### `paleobiology_search_occurrences`

Search fossil occurrences filtered by taxon, geologic time, geography, and environment — the flagship.

- `base_name` (a clade and all its descendants) or `taxon_name` (exact) for the taxon filter
- Age by a named interval (e.g. `Maastrichtian`) or a `max_ma`/`min_ma` range, and/or a lng/lat bounding box
- `environment` enum: `marine`, `terrestrial`, `freshwater`
- Every row carries two distinct coordinate systems — **modern** lng/lat (where the rock is today) and **paleo** lng/lat (where the landmass sat at deposition) — plus formation and age interval
- Broad queries return many rows: an inline preview answers the immediate question, and the full set stages on a DataCanvas (`canvas_id` + `table_name`) for SQL via `paleobiology_dataframe_query`
- Reusing a `canvas_id` **replaces** that canvas's occurrence table — each search restages the full result, it does not accumulate across calls

---

### `paleobiology_get_taxon`

Resolve a taxon by name or integer `taxon_no` to its full record and fossil temporal range — the name-resolution gateway the occurrence and diversity tools depend on.

- Returns accepted name, rank, higher classification, immediate parent, occurrence count, and FAD/LAD range in Ma
- `show_children` also lists immediate child taxa
- PBDB taxonomy is opinionated and can differ from GBIF's backbone, so the accepted name may differ from the searched name — the response surfaces both

---

### `paleobiology_get_diversity`

Compute a diversity / origination / extinction curve for a clade across geologic time.

- Clade-inclusive `base_name`, bound by a named interval (e.g. `Mesozoic`) or a `max_ma`/`min_ma` range
- `count` enum: `genera`, `species`, `families`; `resolution` enum: `period`, `epoch`, `age`
- The full bin set returns inline (a diversity series is a bounded set of geologic intervals)
- Counts reflect **sampled** diversity, biased by collection effort and rock availability — not true past diversity

---

### `paleobiology_search_collections`

Find fossil collections (localities) by area and geologic time — "what has been dug up here, and from what rock."

- Each locality returns location, age (named interval and Ma), formation and strata, lithology, depositional environment, and co-occurring-fossils count
- Filter by `base_name`, a named interval or `max_ma`/`min_ma` range, a lng/lat bounding box, a `formation` or `lithology` name, and/or `environment`
- Results page inline via `limit`/`offset`; the response discloses when more remain
- Take a `collection_no` from a row — or the same bbox+interval — into `paleobiology_search_occurrences` to see the fauna found together

---

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `paleobiology://occurrence/{occurrence_no}` | One fossil occurrence with full detail — modern + paleo coordinates, classification, strata, locality. |
| Resource | `paleobiology://taxon/{taxon_no}` | One taxon record with its fossil range and classification. |

All resource data is also reachable via tools — the resources mirror a single-record read of `paleobiology_search_occurrences` / `paleobiology_get_taxon` for clients that surface resources. Tool-only clients lose nothing. `occurrence_no` and `taxon_no` are bare integers from those tools' output.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth` (runs `none` by default — PBDB is keyless)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Paleobiology-specific:

- Type-safe client for the Paleobiology Database (PBDB) REST API, requesting `vocab=pbdb` so readable field names come straight from upstream instead of hand-mapped terse codes
- Bundled ICS geologic time-scale snapshot — `paleobiology_list_intervals` resolves named intervals ↔ absolute Ma boundaries with no network call
- DataCanvas spill for broad occurrence queries: an inline preview plus a staged table queryable with read-only SQL (count by interval, group by formation/country/lithology)

Agent-friendly output:

- Two coordinate systems on every occurrence — modern lng/lat and paleo lng/lat — distinctly labeled, so an agent never plots a deep-time fossil on a modern coastline
- Both temporal representations on every age — the named interval **and** its Ma boundaries
- Provenance and honesty — every row carries its `reference_no`, responses carry the CC-BY attribution, sparse upstream fields (paleo-coords, formation, `late_interval`) are omitted rather than zeroed, and diversity counts are flagged as sampled

---

## Getting started

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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

Data is from the [Paleobiology Database](https://paleobiodb.org), licensed CC BY 4.0 — credit it in downstream use.
