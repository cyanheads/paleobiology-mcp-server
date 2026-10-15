/**
 * @fileoverview Shared flattener for upstream text rendered into a single
 * `content[]` line.
 *
 * Every `format()` renderer (and the notice text the enrichment trailer quotes)
 * interpolates PBDB-supplied strings into one-line Markdown slots — a `### name`
 * heading, a `**label:** value` line, a list item, a table cell, a `> ` quote. A
 * line break inside the value ends that line early, so its remainder renders as
 * a heading, list item, or label line the server never wrote. Wrapping each
 * interpolated value keeps it on its line; `structuredContent` carries the
 * value verbatim and is never passed through here.
 * @module mcp-server/tools/one-line
 */

/**
 * Runs of Unicode mandatory line breaks (UAX #14 classes BK, CR, LF, NL): LF,
 * VT, FF, CR, NEL, and the line and paragraph separators. CR and LF are the only
 * line endings CommonMark recognizes; the rest are included because a client
 * laying the text out still breaks the visible line there.
 */
const LINE_BREAKS = /[\n\v\f\r\x85\p{Zl}\p{Zp}]+/gu;

/** Flatten every run of line breaks in `text` to one space and trim the ends. */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ').trim();
}
