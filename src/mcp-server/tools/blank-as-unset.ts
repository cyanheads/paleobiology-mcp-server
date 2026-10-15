/**
 * @fileoverview Shared input wrapper that reads a blank optional string as unset.
 *
 * Form-based MCP clients submit every optional field, sending `""` for the ones
 * left empty. The framework deletes a `null` at an optional key but leaves `""`
 * in place, so without this a blank filter counts as supplied: it trips the
 * "at least one filter" and conflicting-selector guards, fails enum validation,
 * or reaches PBDB as a real value. Wrapping the field maps a blank or
 * whitespace-only string to `undefined` before the inner schema runs, so the
 * handler's `!= null` guards see it as omitted and a `.default()` inside the
 * wrapper still applies.
 *
 * The advertised `inputSchema` is unchanged — `toJSONSchema` emits only the inner
 * schema for a preprocess pipe — so the blank stays a tolerated form-client
 * artifact, never documented input. Put `.describe()` on the wrapper, not the
 * inner schema.
 * @module mcp-server/tools/blank-as-unset
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Map a blank or whitespace-only string to `undefined`, then validate with `schema`. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );
