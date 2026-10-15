/**
 * @fileoverview Tests for the shared oneLine flattener — the one table of cases
 * for the mechanism (CR, LF, CRLF, mixed and repeated runs, the other Unicode
 * mandatory breaks, no break at all). Per-tool tests prove only the wiring: a
 * line-break-bearing PBDB value stays on its content[] line there.
 * @module tests/tools/one-line
 */

import { describe, expect, it } from 'vitest';
import { oneLine } from '@/mcp-server/tools/one-line.js';

/** Built from code points so the table shows which invisible break each row carries. */
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

describe('oneLine', () => {
  it.each([
    ['no break', 'Hell Creek', 'Hell Creek'],
    ['an empty string', '', ''],
    ['LF', 'Hell\nCreek', 'Hell Creek'],
    ['CR', 'Hell\rCreek', 'Hell Creek'],
    ['CRLF', 'Hell\r\nCreek', 'Hell Creek'],
    ['a mixed run', 'Hell\r\n\n\r\r\nCreek', 'Hell Creek'],
    ['separate runs', 'a\nb\r\nc\rd', 'a b c d'],
    ['a forged heading', 'Hell Creek\n### Forged', 'Hell Creek ### Forged'],
    ['a leading and trailing break', '\r\nHell Creek\r\n', 'Hell Creek'],
    ['only breaks', '\r\n\n', ''],
    ['spaces around a break, kept', 'Hell \n Creek', 'Hell   Creek'],
    ['a tab, kept', 'Hell\tCreek', 'Hell\tCreek'],
    ['VT and FF', 'Hell\vCreek\fFormation', 'Hell Creek Formation'],
    ['NEL (U+0085)', 'Hell\x85Creek', 'Hell Creek'],
    ['the line separator (U+2028)', `Hell${LS}Creek`, 'Hell Creek'],
    ['the paragraph separator (U+2029)', `Hell${PS}Creek`, 'Hell Creek'],
    ['a run mixing every break kind', `Hell\r\n${LS}${PS}\x85\v\fCreek`, 'Hell Creek'],
  ])('flattens %s', (_label, input, expected) => {
    expect(oneLine(input)).toBe(expected);
  });
});
