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
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';

const ENTRY = new URL('../../src/index.ts', import.meta.url).pathname;
const cwd = mkdtempSync(join(tmpdir(), 'paleo-registration-'));

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

interface StartResult {
  diagnostic: string;
  exitCode: number | null;
  stderr: string;
  tools?: AdvertisedTool[];
}

interface AdvertisedTool {
  inputSchema: { properties: { limit?: { maximum?: number } } };
  name: string;
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
  let stderr = '';
  let tools: AdvertisedTool[] | undefined;
  let phase = 'initialize';
  let problem: string | undefined;
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const fail = (detail: string) => {
    problem ??= `${phase}: ${detail}`;
    child.kill('SIGTERM');
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      problem ??= `Timed out waiting for ${phase}`;
      child.kill('SIGKILL');
    }, 15_000);
    child.on('error', (error) => fail(`Child process error: ${error.message}`));
    child.stdin.on('error', (error) => fail(`Could not write to stdin: ${error.message}`));
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { protocolVersion?: string; tools?: AdvertisedTool[] };
        };
        if (message.id === undefined) return;
        if (phase === 'initialize' && message.id === 0 && message.result?.protocolVersion) {
          phase = 'tools/list';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        } else if (
          phase === 'tools/list' &&
          message.id === 1 &&
          Array.isArray(message.result?.tools)
        ) {
          tools = message.result.tools;
          phase = 'shutdown';
          child.kill('SIGTERM');
        } else {
          fail(`Unexpected MCP response: ${line}`);
        }
      } catch {
        fail(`Invalid JSON on stdout: ${line}`);
      }
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const diagnostic = `${problem ?? `Last phase: ${phase}`}. Exit code: ${exitCode}. Signal: ${signal}.\nStderr:\n${stderr}`;
      const result = { exitCode, stderr, diagnostic };
      resolve(tools && !problem ? { ...result, tools } : result);
    });
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
    ['canvas defaults on', {}, [...DOMAIN_TOOLS, ...QUERY_AND_DESCRIBE]],
    ['canvas off', { CANVAS_PROVIDER_TYPE: 'none' }, DOMAIN_TOOLS],
    [
      'canvas off, limit clamping off',
      { CANVAS_PROVIDER_TYPE: 'none', PBDB_CLAMP_LIMITS: 'false' },
      DOMAIN_TOOLS,
    ],
    [
      'canvas off, drop flag on',
      { CANVAS_PROVIDER_TYPE: 'none', PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'true' },
      DOMAIN_TOOLS,
    ],
    ['canvas on', { CANVAS_PROVIDER_TYPE: 'duckdb' }, [...DOMAIN_TOOLS, ...QUERY_AND_DESCRIBE]],
    [
      'canvas on, drop flag on',
      { CANVAS_PROVIDER_TYPE: 'duckdb', PALEOBIOLOGY_DATAFRAME_DROP_ENABLED: 'true' },
      [...DOMAIN_TOOLS, ...QUERY_AND_DESCRIBE, 'paleobiology_dataframe_drop'],
    ],
  ])('%s → lists exactly the expected tools', async (_label, env, expected) => {
    const result = await start(env);
    expect(result.exitCode, result.diagnostic).toBe(0);
    expect(
      result.tools?.map((tool) => tool.name),
      result.diagnostic,
    ).toStrictEqual(expected);
    for (const name of ['paleobiology_search_occurrences', 'paleobiology_search_collections']) {
      const limit = result.tools?.find((tool) => tool.name === name)?.inputSchema.properties.limit;
      expect(limit).toMatchObject({ type: 'integer', minimum: 1, default: 100 });
      if ('PBDB_CLAMP_LIMITS' in env) {
        expect(limit?.maximum).toBe(10000);
      } else {
        expect(limit?.maximum ?? Number.POSITIVE_INFINITY).toBeGreaterThan(10000);
      }
    }
  });
});

describe('invalid server env var', { timeout: 20_000 }, () => {
  it.each([
    ['PBDB_TIMEOUT_MS', 'PBDB_TIMEOUT_MS', { PBDB_TIMEOUT_MS: 'abc' }],
    ['PBDB_CLAMP_LIMITS', 'PBDB_CLAMP_LIMITS', { PBDB_CLAMP_LIMITS: 'maybe' }],
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
      expect(result.exitCode, result.diagnostic).toBe(1);
      expect(result.stderr).toContain(`${variable} (`);
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.stderr).not.toContain('throw configurationError(');
    },
  );
});
