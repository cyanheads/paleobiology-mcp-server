/**
 * @fileoverview Server-specific configuration for paleobiology-mcp-server.
 * Domain env vars for the Paleobiology Database (PBDB) client and the
 * conditionally-registered dataframe-drop tool. Lazy-parsed and kept separate
 * from the framework's core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
      'Hard cap on occurrence rows pulled per call before the canvas spill closes the stream.',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('When true, registers paleobiology_dataframe_drop. Off by default.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and memoize the server config from the environment.
 * Env var names are surfaced in validation errors via {@link parseEnvConfig}.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    pbdbBaseUrl: 'PBDB_BASE_URL',
    pbdbTimeoutMs: 'PBDB_TIMEOUT_MS',
    pbdbMaxOccurrences: 'PBDB_MAX_OCCURRENCES',
    dataframeDropEnabled: 'PALEOBIOLOGY_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
