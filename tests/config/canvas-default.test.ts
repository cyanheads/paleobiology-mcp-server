/** @fileoverview Node startup defaults before framework validation. @module tests/config/canvas-default */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('loads .env canvas choice without parsing unrelated invalid framework config', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pbdb-env-'));
  try {
    writeFileSync(join(cwd, '.env'), 'CANVAS_PROVIDER_TYPE=none\nMCP_HTTP_PORT=invalid\n');
    const env = { ...process.env };
    delete env.CANVAS_PROVIDER_TYPE;
    delete env.MCP_HTTP_PORT;
    const module = new URL('../../src/config/canvas-default.ts', import.meta.url).href;
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(module)}); console.log(process.env.CANVAS_PROVIDER_TYPE);`,
      ],
      { cwd, env, timeout: 10_000, encoding: 'utf8' },
    );
    expect(output.trim()).toBe('none');
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

it('defers an unreadable .env path to framework startup validation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pbdb-env-'));
  try {
    mkdirSync(join(cwd, '.env'));
    const env = { ...process.env };
    delete env.CANVAS_PROVIDER_TYPE;
    const module = new URL('../../src/config/canvas-default.ts', import.meta.url).href;
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(module)}); console.log(process.env.CANVAS_PROVIDER_TYPE);`,
      ],
      { cwd, env, timeout: 10_000, encoding: 'utf8' },
    );
    expect(output.trim()).toBe('duckdb');
  } finally {
    rmSync(cwd, { recursive: true });
  }
});
