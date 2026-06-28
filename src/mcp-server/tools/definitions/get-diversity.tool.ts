/**
 * @fileoverview paleobiology_get_diversity — diversity / origination / extinction through time.
 * Bins a clade's diversity over an interval by period, epoch, or age and returns
 * the full bin set inline (a diversity curve tops out at the geologic-interval
 * count, ≤ ~100). No canvas spill.
 * @module mcp-server/tools/definitions/get-diversity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPbdbService } from '@/services/pbdb/pbdb-service.js';
import type { DiversityFilter } from '@/services/pbdb/types.js';
import { PBDB_ATTRIBUTION } from '@/services/pbdb/types.js';

const COUNTS = ['genera', 'species', 'families'] as const;
const RESOLUTIONS = ['period', 'epoch', 'age'] as const;

const BinSchema = z
  .object({
    interval: z.string().describe('Geologic interval (bin) name, e.g. "Cretaceous".'),
    max_ma: z.number().describe('Older boundary of the bin in millions of years ago.'),
    min_ma: z.number().describe('Younger boundary of the bin in millions of years ago.'),
    sampled_in_bin: z.number().describe('Taxa with at least one occurrence inside this bin.'),
    implied: z
      .number()
      .describe('Range-through taxa implied present in the bin but without an occurrence in it.'),
    originations: z
      .number()
      .describe(
        'Taxa whose first appearance is in this bin (new FADs, including bin-only singletons).',
      ),
    extinctions: z
      .number()
      .describe('Taxa whose last appearance is in this bin (LADs, including bin-only singletons).'),
    range_through: z
      .number()
      .describe('Taxa whose range crosses both boundaries of this bin (present before and after).'),
    n_occurrences: z.number().describe('Total fossil occurrences counted in this bin.'),
  })
  .describe('One diversity bin (a single geologic interval) with turnover counts.');

export const getDiversityTool = tool('paleobiology_get_diversity', {
  title: 'paleobiology-mcp-server: diversity through time',
  description:
    'Compute a diversity / origination / extinction curve for a clade across geologic time, binned ' +
    'by period, epoch, or age — answers "plot dinosaur genus diversity across the Mesozoic." Pass a ' +
    'clade-inclusive base_name and bound the span by a named interval (e.g. "Mesozoic") or a ' +
    'max_ma/min_ma range; choose what to count (genera, species, or families) and the bin resolution. ' +
    'The full bin set returns inline — a diversity series is a bounded set of geologic intervals — so ' +
    'you read the curve, the turnover, and the per-bin origination/extinction directly. Counts reflect ' +
    'SAMPLED diversity, biased by collection effort and rock availability, not true past diversity.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    base_name: z
      .string()
      .describe(
        'Clade-inclusive taxon to count, e.g. "Dinosauria" or "Ammonoidea" — this taxon and all descendants.',
      ),
    count: z
      .enum(COUNTS)
      .default('genera')
      .describe('What to count per bin: "genera" (default), "species", or "families".'),
    resolution: z
      .enum(RESOLUTIONS)
      .default('period')
      .describe('Bin resolution: "period" (default, coarse), "epoch", or "age" (finest).'),
    interval: z
      .string()
      .optional()
      .describe(
        'Named geologic interval bounding the span, e.g. "Mesozoic". Alternative to max_ma/min_ma.',
      ),
    max_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Older bound of the span in millions of years ago. Pair with min_ma; alternative to interval.',
      ),
    min_ma: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Younger bound of the span in millions of years ago. Pair with max_ma; alternative to interval.',
      ),
  }),
  output: z.object({
    bins: z
      .array(BinSchema)
      .describe(
        'Per-interval diversity bins over the span, ordered oldest-first (oldest geologic interval, highest max_ma, first).',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Number of geologic-interval bins returned.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the clade or span produced no bins, plus the sampling-bias caveat.'),
    attribution: z.string().describe('CC-BY data attribution for the Paleobiology Database.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Source' },
  },

  async handler(input, ctx) {
    const filter: DiversityFilter = {
      baseName: input.base_name,
      count: input.count,
      resolution: input.resolution,
    };
    if (input.interval) filter.interval = input.interval;
    if (input.max_ma != null) filter.maxMa = input.max_ma;
    if (input.min_ma != null) filter.minMa = input.min_ma;

    const bins = await getPbdbService().getDiversity(filter, ctx);
    // PBDB returns bins newest-first; present them oldest-first (highest max_ma
    // first) so the curve reads as a timeline and matches the output schema.
    bins.sort((a, b) => b.max_ma - a.max_ma);
    ctx.enrich({ attribution: PBDB_ATTRIBUTION });
    ctx.enrich.total(bins.length);
    ctx.log.info('Diversity curve', { base_name: input.base_name, bins: bins.length });

    if (bins.length === 0) {
      ctx.enrich.notice(
        `No diversity bins for "${input.base_name}" over the requested span. Verify the taxon name with ` +
          'paleobiology_get_taxon and confirm the interval/Ma range overlaps its fossil range.',
      );
    }
    return { bins };
  },

  format: (result) => {
    if (result.bins.length === 0) {
      return [{ type: 'text', text: 'No diversity bins matched the clade and span.' }];
    }
    const header =
      '| interval | age (Ma) | sampled | implied | originations | extinctions | range-through | occurrences |';
    const sep = '| --- | --- | --- | --- | --- | --- | --- | --- |';
    const rows = result.bins.map(
      (b) =>
        `| ${b.interval} | ${b.max_ma}–${b.min_ma} | ${b.sampled_in_bin} | ${b.implied} | ${b.originations} | ${b.extinctions} | ${b.range_through} | ${b.n_occurrences} |`,
    );
    return [
      {
        type: 'text',
        text: [
          `**${result.bins.length} diversity bin(s)** (sampled diversity)`,
          '',
          header,
          sep,
          ...rows,
        ].join('\n'),
      },
    ];
  },
});
