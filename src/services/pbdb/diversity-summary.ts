/** @fileoverview PBDB's readable-vocabulary diversity counters, shared with the tool output contract. */
import { z } from '@cyanheads/mcp-ts-core';

/** Counters PBDB reports with datainfo, preserving missing counters. */
export const DiversitySummarySchema = z
  .object({
    n_occs: z.number().int().nonnegative().optional().describe('Occurrences scanned.'),
    bin_total: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Sum of occurrence counts across bins; an occurrence can count in multiple bins with overlap.',
      ),
    imprecise_time: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Occurrences skipped because their ages were too imprecise.'),
    imprecise_taxon: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Occurrences skipped because identification was too imprecise for the counted rank.',
      ),
    missing_taxon: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Occurrences skipped because the taxonomic hierarchy was incomplete.'),
  })
  .describe('Occurrence coverage counters reported by PBDB. Absent counters were not supplied.');

/** Validated occurrence coverage counters from PBDB. */
export type DiversitySummary = z.infer<typeof DiversitySummarySchema>;
