/**
 * @fileoverview Shared test helper for asserting on the `McpError` a tool or
 * resource handler throws. A handler's declared return type is
 * `T | Promise<T>`, so `.catch(...)` at the call site does not typecheck;
 * awaiting inside the helper normalizes both forms and proves the handler
 * actually failed before the caller asserts on `code`, `message`, or `data`.
 * Mirrors the framework's own `expectInputRequired(run)` thunk convention.
 * @module tests/helpers/expect-error
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Runs a handler and returns the `McpError` it threw.
 *
 * @param run - Thunk invoking the handler. A synchronous throw is captured too.
 * @returns The thrown `McpError`.
 * @throws When the handler resolved, or threw something other than an
 *   `McpError` — that value propagates untouched.
 */
export async function expectMcpError(run: () => unknown): Promise<McpError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the handler to throw an McpError, but it resolved.');
}
