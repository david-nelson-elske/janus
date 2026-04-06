/**
 * audit-relational — Write audit records to execution_log.
 *
 * Writes directly to the store (not via _dispatch) to avoid nested
 * transaction issues. Audit runs inside the tx group, so the write
 * participates in the same transaction.
 *
 * STABLE — ADR 05 invariant.
 */

import type { ExecutionHandler } from '@janus/core';
import { writeExecutionLog, snapshotIdentity } from './execution-log';

/**
 * Create an audit handler with the given name and retention policy.
 * audit-relational uses 'forever', audit-memory uses 'volatile'.
 */
export function createAuditHandler(handlerName: string, retention: string): ExecutionHandler {
  return async (ctx) => {
    // Skip audit for internal dispatches to prevent recursion
    if (ctx.depth > 0) return;

    const payload: Record<string, unknown> = {
      actor: snapshotIdentity(ctx.identity),
      correlationId: ctx.correlationId,
    };

    if (ctx.before) {
      payload.before = ctx.before;
    }

    if (ctx.result?.kind === 'record') {
      payload.after = ctx.result.record;
    }

    try {
      await writeExecutionLog(ctx, { handler: handlerName, retention, payload });
    } catch {
      // Best-effort — don't break the dispatch if audit write fails
    }
  };
}

export const auditRelational = createAuditHandler('audit-relational', 'forever');
