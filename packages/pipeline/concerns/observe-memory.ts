/**
 * observe-memory — Write observation records to execution_log. Best-effort.
 *
 * Non-transactional (postTx). Errors propagate to the dispatch runtime's
 * postTx catch, which captures them in ctx.outboundErrors.
 *
 * STABLE — ADR 05 invariant.
 */

import type { ExecutionHandler } from '@janus/core';
import { writeExecutionLog } from './execution-log';

export const observeMemory: ExecutionHandler = async (ctx) => {
  // Skip observation for internal dispatches to prevent recursion
  if (ctx.depth > 0) return;

  await writeExecutionLog(ctx, {
    handler: 'observe-memory',
    retention: '7d',
    payload: { event: ctx.operation, entity: ctx.entity },
  });
};
