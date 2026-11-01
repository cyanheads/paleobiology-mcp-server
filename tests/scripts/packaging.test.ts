/** @fileoverview Bundle cleanup preserves executable SDK modules. @module tests/scripts/packaging */
import { expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linter } from '../../scripts/lint-packaging.js';

it('preserves runtime skills while pruning package-root documentation', () => {
  for (const matcher of [cleaner, linter]) {
    for (const path of [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/a/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    ])
      expect(matcher.test(path)).toBe(false);
    for (const path of [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/setup/SKILL.md',
      'node_modules/a/node_modules/@scope/pkg/skills/guide/file.md',
      'node_modules/pkg/.agents/rules.md',
    ])
      expect(matcher.test(path)).toBe(true);
  }
});
