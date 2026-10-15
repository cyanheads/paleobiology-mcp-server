/**
 * @fileoverview Table tests for the shared inline response budget: the whole-row
 * prefix fit across every client surface, the reserve, UTF-8 byte counting, and
 * the JSON array element cost.
 * @module tests/tools/inline-budget
 */

import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_RESERVE_BYTES,
  fitRows,
  INLINE_BUDGET_BYTES,
  jsonItemBytes,
  utf8Bytes,
} from '@/mcp-server/tools/inline-budget.js';

const ROOM = INLINE_BUDGET_BYTES - ENVELOPE_RESERVE_BYTES;
const flat = (bytes: number) => () => bytes;

describe('fitRows', () => {
  it.each([
    { name: 'no rows', rows: 0, cost: 10, expected: 0 },
    { name: 'every row fits', rows: 100, cost: 10, expected: 100 },
    { name: 'the budget is reached exactly', rows: 10, cost: ROOM / 4, expected: 4 },
    { name: 'one byte over cuts that row', rows: 10, cost: ROOM / 4 + 1, expected: 3 },
    { name: 'a row too large on its own', rows: 3, cost: ROOM + 1, expected: 0 },
  ])('$name → $expected', ({ rows, cost, expected }) => {
    expect(fitRows(Array.from({ length: rows }), [flat(cost)])).toBe(expected);
  });

  it('cuts at the surface that binds first, keeping one prefix for both', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    // The second surface costs 3× the first, so it alone decides the cut.
    expect(fitRows(rows, [flat(100), flat(300)])).toBe(Math.floor(ROOM / 300));
    expect(fitRows(rows, [flat(300), flat(100)])).toBe(Math.floor(ROOM / 300));
  });

  it('cuts at the first row that crosses, even when later rows are small', () => {
    const sizes = [ROOM - 10, 50, 1, 1];
    expect(fitRows(sizes, [(n) => n])).toBe(1);
  });

  it('takes a caller reserve in place of the default', () => {
    const rows = Array.from({ length: 200 }, () => 0);
    expect(fitRows(rows, [flat(1000)], 0)).toBe(100);
    expect(fitRows(rows, [flat(1000)], 50_000)).toBe(50);
    expect(fitRows(rows, [flat(1000)])).toBe(96);
  });
});

describe('utf8Bytes / jsonItemBytes', () => {
  it.each([
    ['ascii', 'abc', 3],
    ['two-byte', 'é', 2],
    ['three-byte', '—', 3],
    ['four-byte', '🦖', 4],
  ])('counts %s text in UTF-8 bytes', (_label, text, bytes) => {
    expect(utf8Bytes(text)).toBe(bytes);
  });

  it('prices a row as its JSON serialization plus the array separator', () => {
    expect(jsonItemBytes({ a: 'é' })).toBe(utf8Bytes('{"a":"é"}') + 1);
    expect(jsonItemBytes({ a: 1, b: undefined })).toBe('{"a":1}'.length + 1);
  });
});
