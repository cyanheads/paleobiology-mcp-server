/** @fileoverview PBDB country grammar, normalization, and caller-sized input bounds. */
import { expect, it } from 'vitest';
import { CountryFilterSchema } from '@/mcp-server/tools/country-filter.js';

it.each([
  [' us , ca ', 'US,CA'],
  ['! eur , ^is', '!EUR,^IS'],
  ['noa,soa,^ar,^bo', 'NOA,SOA,^AR,^BO'],
  ['UK', 'UK'],
  ['ATA,AU', 'ATA,AU'],
])('normalizes %s without changing operators', (input, expected) =>
  expect(CountryFilterSchema.parse(input)).toBe(expected),
);
it.each(['USA', '', 'US,', 'US,,CA', 'US,!CA', '!!US', 'NOA,^^US', 'U S', 'ZZZ'])(
  'rejects malformed country %s',
  (input) => expect(CountryFilterSchema.safeParse(input).success).toBe(false),
);
it('bounds country parsing CPU over a 64-fold input span', () => {
  const shapes = [
    (n: number) => ({ value: 'US,'.repeat(Math.floor(n / 3)) + 'CA', valid: true }),
    (n: number) => ({ value: '!'.repeat(n), valid: false }),
    (n: number) => ({ value: '^^'.repeat(Math.floor(n / 2)), valid: false }),
    (n: number) => ({ value: 'US,'.repeat(Math.floor(n / 3)) + 'USA', valid: false }),
    (n: number) => ({ value: 'A'.repeat(n) + '\n', valid: false }),
    (n: number) => ({ value: 'U\nS,'.repeat(Math.floor(n / 4)) + 'CA', valid: false }),
  ];
  for (const shape of shapes) {
    const times: number[] = [];
    for (const size of [5000, 10000, 20000, 40000, 80000, 160000, 320000]) {
      const input = shape(size);
      const start = process.threadCpuUsage();
      const result = CountryFilterSchema.safeParse(input.value);
      const cpu = process.threadCpuUsage(start);
      const used = cpu.user + cpu.system;
      expect(result.success).toBe(input.valid);
      expect(used).toBeLessThan(500000);
      times.push(used);
    }
    expect(times.at(-1)!).toBeLessThan(Math.max(times[0]!, 1000) * 256);
  }
});
