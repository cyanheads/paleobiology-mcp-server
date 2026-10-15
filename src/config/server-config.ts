/**
 * @fileoverview Server-specific configuration for paleobiology-mcp-server.
 * Domain env vars for the Paleobiology Database (PBDB) client and the opt-in
 * dataframe-drop tool. Lazy-parsed (fully, in setup()) and kept separate from
 * the framework's core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  pbdbBaseUrl: z
    .string()
    .url()
    .default('https://paleobiodb.org/data1.2')
    .describe('Base URL for the PBDB REST API (no trailing slash).'),
  pbdbTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request timeout in milliseconds for PBDB calls.'),
  pbdbMaxOccurrences: z.coerce
    .number()
    .int()
    .positive()
    .default(1000)
    .describe(
      'Hard cap on occurrence or collection rows pulled per call. The tools already pull at most 500 per call, so only a lower value takes effect.',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'When true, enables paleobiology_dataframe_drop (DataCanvas must also be on). Off by default.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const ENV_MAP = {
  pbdbBaseUrl: 'PBDB_BASE_URL',
  pbdbTimeoutMs: 'PBDB_TIMEOUT_MS',
  pbdbMaxOccurrences: 'PBDB_MAX_OCCURRENCES',
  dataframeDropEnabled: 'PALEOBIOLOGY_DATAFRAME_DROP_ENABLED',
} as const;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and memoize the server config from the environment.
 * Env var names are surfaced in validation errors via {@link parseEnvConfig}.
 * Called in setup(), so an invalid value fails startup behind the banner.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_MAP);
  return _config;
}

/**
 * Read only the dataframe-drop flag, for the tool barrel's module-load gate.
 * Never throws and parses no other field, so a bad value elsewhere cannot
 * crash the import. A flag value its schema rejects reads as off here; the
 * full {@link getServerConfig} parse in setup() then reports it.
 */
export function isDataframeDropEnabled(): boolean {
  const parsed = ServerConfigSchema.pick({ dataframeDropEnabled: true }).safeParse(
    normalizeEnv({ dataframeDropEnabled: process.env[ENV_MAP.dataframeDropEnabled] }),
  );
  return parsed.success && parsed.data.dataframeDropEnabled;
}
