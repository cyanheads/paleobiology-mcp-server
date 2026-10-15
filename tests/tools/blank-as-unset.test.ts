/**
 * @fileoverview Tests for the shared blankAsUnset input wrapper — the one table of
 * cases for the mechanism (blank, whitespace-only, padded, absent, wrong-type
 * values; a defaulted enum), proof that the wrapper leaves the emitted JSON
 * Schema byte-identical at its own seam, and the tools/list regression: every
 * field the five domain tools wrap still advertises exactly what it did before
 * the wrapper existed. Per-tool tests prove only the wiring.
 * @module tests/tools/blank-as-unset
 */

import { z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { describe, expect, it } from 'vitest';
import { blankAsUnset } from '@/mcp-server/tools/blank-as-unset.js';
import { getDiversityTool } from '@/mcp-server/tools/definitions/get-diversity.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { listIntervalsTool } from '@/mcp-server/tools/definitions/list-intervals.tool.js';
import { searchCollectionsTool } from '@/mcp-server/tools/definitions/search-collections.tool.js';
import { searchOccurrencesTool } from '@/mcp-server/tools/definitions/search-occurrences.tool.js';

/** The JSON Schema a client reads — the same `~standard` path `tools/list` advertises. */
function advertised(schema: z.ZodType, io: 'input' | 'output' = 'input'): unknown {
  return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
}

describe('blankAsUnset', () => {
  const optionalString = blankAsUnset(z.string().optional());

  it.each([
    ['an empty string', '', undefined],
    ['spaces', '   ', undefined],
    ['tabs and newlines', '\t\n ', undefined],
    ['an absent value', undefined, undefined],
    ['a real value', 'Dinosauria', 'Dinosauria'],
    ['a padded real value, untrimmed', '  Hell Creek ', '  Hell Creek '],
  ])('reads %s as %s', (_label, value, expected) => {
    expect(optionalString.parse(value)).toBe(expected);
  });

  it('leaves a null and a non-string to the inner schema', () => {
    expect(optionalString.safeParse(null).success).toBe(false);
    expect(optionalString.safeParse(42).success).toBe(false);
  });

  it('lets a .default() inside the wrapper fill a blank', () => {
    const count = blankAsUnset(z.enum(['genera', 'species']).default('genera'));
    expect(count.parse('')).toBe('genera');
    expect(count.parse('  ')).toBe('genera');
    expect(count.parse(undefined)).toBe('genera');
    expect(count.parse('species')).toBe('species');
    expect(count.safeParse('bogus').success).toBe(false);
  });

  it('still validates a real value against the inner pattern', () => {
    const canvasId = blankAsUnset(CanvasIdSchema.optional());
    expect(canvasId.parse('')).toBeUndefined();
    expect(canvasId.parse('abcde_1234')).toBe('abcde_1234');
    expect(canvasId.safeParse('not a canvas id').success).toBe(false);
  });

  it.each([
    ['an optional string', () => z.string().optional()],
    ['an optional enum', () => z.enum(['marine', 'terrestrial']).optional()],
    ['a defaulted enum', () => z.enum(['genera', 'species']).default('genera')],
    ['an optional patterned string', () => CanvasIdSchema.optional()],
  ])('emits the same JSON Schema as the bare field for %s', (_label, inner) => {
    const bare = z.object({ f: inner().describe('A field.') }).strict();
    const wrapped = z.object({ f: blankAsUnset(inner()).describe('A field.') }).strict();
    expect(advertised(wrapped)).toStrictEqual(advertised(bare));
    expect(advertised(wrapped, 'output')).toStrictEqual(advertised(bare, 'output'));
  });
});

/**
 * The advertised schema of every wrapped field, captured from `tools/list` before
 * the wrapper was introduced. No domain tool marks any field required.
 */
const PRE_WRAPPER_FIELDS: Record<string, Record<string, unknown>> = {
  paleobiology_search_occurrences: {
    base_name: {
      description:
        'Clade-inclusive taxon filter — this taxon and all descendants, e.g. "Dinosauria". The usual choice. Supply this or base_id, never both.',
      type: 'string',
    },
    taxon_name: {
      description:
        'Exact taxon filter — only this taxon, not descendants. Use instead of base_name when you want a single taxon.',
      type: 'string',
    },
    interval: {
      description:
        'Named geologic interval bounding the age, e.g. "Cretaceous" or "Maastrichtian". Alternative to max_ma/min_ma.',
      type: 'string',
    },
    canvas_id: {
      description:
        'Canvas id from a prior call to re-stage onto the same workspace. Used only when this page spills: reusing it REPLACES (overwrites) the prior occurrence table — each search restages the full result, it does not append to or accumulate across earlier ones — while a page that fits inline leaves that canvas untouched. Omit to start fresh; a spilled response returns a new id.',
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{10}$',
    },
    environment: {
      description:
        'Depositional environment: "marine", "terrestrial", or "freshwater" (lacustrine + fluvial). Omit for all.',
      type: 'string',
      enum: ['marine', 'terrestrial', 'freshwater'],
    },
  },
  paleobiology_search_collections: {
    base_name: {
      description:
        'Clade-inclusive taxon filter — localities yielding this taxon or its descendants, e.g. "Dinosauria". Supply this or base_id, never both.',
      type: 'string',
    },
    interval: {
      description:
        'Named geologic interval bounding the age, e.g. "Maastrichtian". Alternative to max_ma/min_ma.',
      type: 'string',
    },
    formation: {
      description: 'Geologic formation name to filter by, e.g. "Hell Creek".',
      type: 'string',
    },
    lithology: {
      description: 'Lithology (rock type) to filter by, e.g. "sandstone".',
      type: 'string',
    },
    environment: {
      description:
        'Depositional environment: "marine", "terrestrial", or "freshwater" (lacustrine + fluvial). Omit for all.',
      type: 'string',
      enum: ['marine', 'terrestrial', 'freshwater'],
    },
  },
  paleobiology_get_diversity: {
    base_name: {
      description:
        'Clade-inclusive taxon to count, e.g. "Dinosauria" or "Ammonoidea" — this taxon and all descendants. Supply this or base_id (exactly one is required, never both).',
      type: 'string',
    },
    interval: {
      description:
        'Named geologic interval bounding the span, e.g. "Mesozoic". Alternative to max_ma/min_ma.',
      type: 'string',
    },
    count: {
      default: 'genera',
      description: 'What to count per bin: "genera" (default), "species", or "families".',
      type: 'string',
      enum: ['genera', 'species', 'families'],
    },
    resolution: {
      default: 'period',
      description: 'Bin resolution: "period" (default, coarse), "epoch", or "age" (finest).',
      type: 'string',
      enum: ['period', 'epoch', 'age'],
    },
  },
  paleobiology_get_taxon: {
    name: {
      description:
        'Taxon name to resolve, e.g. "Tyrannosaurus" or "Ammonoidea". Provide this or taxon_no.',
      type: 'string',
    },
  },
  paleobiology_list_intervals: {
    name: {
      description:
        'Case-insensitive substring of the interval name, e.g. "cretaceous" or "Jurassic". A name the bundled international scale does not carry is matched exactly against PBDB\'s other time scales.',
      type: 'string',
    },
    level: {
      description:
        'Restrict to one rank of the international scale: eon, era, period, epoch, or age (finest). Browsing is bounded to that scale, so the sub-stage and regional ranks are not selectable here.',
      type: 'string',
      enum: ['eon', 'era', 'period', 'epoch', 'age'],
    },
  },
};

describe('tools/list input schemas of the wrapped fields', () => {
  it.each([
    searchOccurrencesTool,
    searchCollectionsTool,
    getDiversityTool,
    getTaxonTool,
    listIntervalsTool,
  ])('$name advertises each wrapped field unchanged', (def) => {
    const emitted = advertised(def.input) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const fields = PRE_WRAPPER_FIELDS[def.name];
    expect(fields).toBeDefined();
    for (const [field, schema] of Object.entries(fields ?? {})) {
      expect(emitted.properties[field], field).toStrictEqual(schema);
    }
    expect(emitted.required).toBeUndefined();
  });
});
