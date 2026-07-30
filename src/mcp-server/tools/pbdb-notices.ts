/**
 * @fileoverview Shared notice text for PBDB's non-fatal `warnings[]` channel.
 *
 * PBDB reports a filter value it could not resolve in `warnings[]` and still
 * answers HTTP 200 with a result set. For `lithology` that result set is the FULL
 * UNFILTERED one — an unrecognized value is dropped from the query rather than
 * matching nothing — so a discarded warning turns "your filter was ignored" into
 * something indistinguishable from a genuine match. For a taxon name it is what
 * separates "that name is a typo" from "valid query, nothing overlapped".
 *
 * The three list searches compose this into their `notice` enrichment. Warnings
 * are guidance on a SUCCESSFUL call — never an error.
 * @module mcp-server/tools/pbdb-notices
 */

/**
 * Disclose that PBDB ignored part of the query, quoting its own warning text.
 * Returns `undefined` when there is nothing to disclose, so it composes away.
 */
export function ignoredFilterNotice(warnings: string[] | undefined): string | undefined {
  if (!warnings || warnings.length === 0) return;
  return (
    `PBDB could not use part of this query: ${warnings.join('; ')}. That filter did not constrain ` +
    'the result — correct the value or drop it before treating these records as a match on it.'
  );
}

/** Join the present notice fragments into one string (the enrichment holds a single notice). */
export function joinNotices(...parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}

/** The slice of `ctx` a notice is written to — satisfied by both the loose and typed `enrich`. */
type NoticeSink = { enrich: { notice: (text: string) => void } };

/**
 * Write the composed notice, skipping the call when no fragment is present —
 * `ctx.enrich.notice('')` would publish an empty field. Every notice branch goes
 * through here so an ignored-filter disclosure cannot be dropped by a branch that
 * forgot to re-emit it.
 */
export function emitNotice(ctx: NoticeSink, ...parts: (string | undefined)[]): void {
  const text = joinNotices(...parts);
  if (text) ctx.enrich.notice(text);
}
