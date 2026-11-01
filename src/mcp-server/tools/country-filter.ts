/** @fileoverview PBDB country/continent list grammar shared by spatial filters. */
import { z } from '@cyanheads/mcp-ts-core';

/** Normalize PBDB codes while preserving per-token exclusion/subtraction operators. */
export const CountryFilterSchema = z
  .string()
  .overwrite((value) =>
    value
      .split(',')
      .map((raw) => {
        const token = raw.trim().toUpperCase();
        return token.startsWith('!') || token.startsWith('^')
          ? token[0] + token.slice(1).trim()
          : token;
      })
      .join(','),
  )
  .regex(
    /^[!^]?(?:[A-Z]{2}|NOA|SOA|EUR|ASI|AFR|AUS|ATA|OCE|IOC)(?:,\^?(?:[A-Z]{2}|NOA|SOA|EUR|ASI|AFR|AUS|ATA|OCE|IOC))*$/,
    'Use comma-separated two-letter country codes or PBDB continent codes (NOA, SOA, EUR, ASI, AFR, AUS, ATA, OCE, IOC), with ! only before the first code and ^ before subtracted codes.',
  );
