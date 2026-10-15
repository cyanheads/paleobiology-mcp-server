/**
 * @fileoverview Shared test helper measuring what a caller receives on each
 * client surface of a tool result: the `structuredContent` JSON and the joined
 * `content[]` text (the enrichment trailer included), both in UTF-8 bytes.
 * @module tests/helpers/surface-bytes
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** UTF-8 byte sizes of both surfaces of an assembled tool result. */
export function surfaceBytes(result: Awaited<ReturnType<typeof runToolContract>>): {
  structured: number;
  text: number;
} {
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return {
    structured: Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'),
    text: Buffer.byteLength(text, 'utf8'),
  };
}
