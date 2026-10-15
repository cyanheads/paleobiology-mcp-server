/**
 * @fileoverview Tool registration gates, exercised against the real entry point.
 * Spawns `bun src/index.ts` over stdio from an empty working directory (no
 * `.env`) and reads `tools/list`: the dataframe trio is listed only with
 * DataCanvas on, and drop also needs its own flag. Also pins that an invalid
 * server env var fails startup through setup() rather than at import.
 * @module tests/tools/tool-registration
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ENTRY = new URL('../../src/index.ts', import.meta.url).pathname;
const cwd = mkdtempSync(join(tmpdir(), 'paleo-registration-'));

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

interface StartResult {
  exitCode: number | null;
  stderr: string;
  tools?: string[];
}

/** Start the server with only the given env, list its tools, then stop it. */
function start(env: Record<string, string>): Promise<StartResult> {
  const child = spawn('bun', [ENTRY], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'error',
      ...env,
    },
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  let tools: string[] | undefined;
  child.stderr.on('data', (d: Buffer) => {
    stderr += d;
  });
  child.stdout.on('data', (d: Buffer) => {
    stdout += d;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const msg = JSON.parse(line) as { id?: number; result?: { tools: { name: string }[] } };
      if (msg.id === 1 && msg.result) {
        tools = msg.result.tools.map((t) => t.name);
        child.kill('SIGTERM');
      }
    }
  });
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'registration-test', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve) => {
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(tools ? { exitCode, stderr, tools } : { exitCode, stderr });
    });
  });
}

const DOMAIN_TOOLS = [
  'paleobiology_search_occurrences',
  'paleobiology_get_taxon',
  'paleobiology_get_diversity',
  'paleobiology_list_intervals',
  'paleobiology_search_collections',
  'paleobiology_get_references',
];
const QUERY_AND_DESCRIBE = ['paleobiology_dataframe_query', 'paleobiology_dataframe_describe'];

describe('dataframe tool registration', { timeout: 20_000 }, () => {
  it.each([
    ['canvas off', {}, DOMAIN_TOOLS],
    ['canvas off, drop flag on', { PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'true' }, DOMAIN_TOOLS],
    ['canvas on', { CANVAS_PROVIDER_TYPE: 'duckdb' }, [...DOMAIN_TOOLS, ...QUERY_AND_DESCRIBE]],
    [
      'canvas on, drop flag on',
      { CANVAS_PROVIDER_TYPE: 'duckdb', PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'true' },
      [...DOMAIN_TOOLS, ...QUERY_AND_DESCRIBE, 'paleobiology_dataframe_drop'],
    ],
  ])('%s → lists exactly the expected tools', async (_label, env, expected) => {
    const result = await start(env);
    expect(result.tools).toStrictEqual(expected);
  });
});

describe('invalid server env var', { timeout: 20_000 }, () => {
  it.each([
    ['PBDB_TIMEOUT_MS', 'PBDB_TIMEOUT_MS', { PBDB_TIMEOUT_MS: 'abc' }],
    [
      'PBDB_TIMEOUT_MS with the drop flag',
      'PBDB_TIMEOUT_MS',
      { PBDB_TIMEOUT_MS: 'abc', PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'true' },
    ],
    [
      'PALEOBIOLOGY_DATAFRAME_DROP_ENABLED',
      'PALEOBIOLOGY_DATAFRAME_DROP_ENABLED',
      { PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'maybe' },
    ],
  ])(
    '%s fails startup in setup() with a banner, not an import stack',
    async (_label, variable, env) => {
      const result = await start(env);
      expect(result.tools).toBeUndefined();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${variable} (`);
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.stderr).not.toContain('throw configurationError(');
    },
  );
});
