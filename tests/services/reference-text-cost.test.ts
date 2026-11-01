/**
 * @fileoverview CPU bounds and text preservation for reference HTML normalization.
 * @module tests/services/reference-text-cost
 */
import { describe, expect, it } from 'vitest';
import { normalizeReference } from '@/services/pbdb/pbdb-service.js';

describe('reference text conversion cost', () => {
  it.each(['literal', 'nested', 'entities', 'final break', 'many breaks'] as const)(
    'preserves %s text across input sizes',
    (shape) => {
      const inputAt = (size: number): [string, string] => {
        switch (shape) {
          case 'literal':
            return ['< '.repeat(size / 2), '< '.repeat(size / 2)];
          case 'nested':
            return [
              '<i>'.repeat(Math.floor(size / 7)) + 'x' + '</i>'.repeat(Math.floor(size / 7)),
              'x',
            ];
          case 'entities':
            return ['&amp;'.repeat(size / 5), '&'.repeat(size / 5)];
          case 'final break':
            return ['a'.repeat(size) + '\r\n', 'a'.repeat(size) + '\r\n'];
          case 'many breaks':
            return ['a\r\n'.repeat(Math.floor(size / 3)), 'a\r\n'.repeat(Math.floor(size / 3))];
        }
      };
      const convert = (text: string) =>
        normalizeReference({ reference_no: '1', formatted: text }).citation;
      const [warm] = inputAt(320_000);
      for (let n = 0; n < 4; n++) convert(warm);
      const costs: number[] = [];
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const [input, expected] = inputAt(size);
        expect(convert(input)).toBe(expected);
        const samples: number[] = [];
        for (let n = 0; n < 3; n++) {
          const start = process.threadCpuUsage();
          convert(input);
          const used = process.threadCpuUsage(start);
          samples.push(used.user + used.system);
        }
        const cpuUs = samples.sort((a, b) => a - b)[1]!;
        expect(cpuUs).toBeLessThan(500_000);
        costs.push(cpuUs);
      }
      expect(costs.at(-1)! / Math.max(costs[0]!, 1)).toBeLessThan(256);
    },
  );
});
