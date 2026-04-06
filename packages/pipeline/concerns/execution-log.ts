/**
 * Shared execution_log helpers — used by audit, observe, and other
 * concerns that write to the execution_log entity.
 *
 * STABLE — execution_log is the canonical output entity (ADR 05).
 */

import type { ConcernContext, EntityRecord, Identity } from '@janus/core';

/** Extract entity id from dispatch result, falling back to ctx.before. */
export function resolveEntityId(ctx: ConcernContext): string | undefined {
  if (ctx.result?.kind === 'record') return (ctx.result.record as EntityRecord).id;
  if (ctx.before) return (ctx.before as EntityRecord).id;
  return undefined;
}

/** Snapshot identity for audit/event payloads (avoids referencing the live object). */
export function snapshotIdentity(identity: Identity): { id: string; roles: readonly string[] } {
  return { id: identity.id, roles: [...identity.roles] };
}

/** Write a record to execution_log via the store. */
export async function writeExecutionLog(
  ctx: ConcernContext,
  opts: {
    readonly handler: string;
    readonly retention: string;
    readonly payload: Record<string, unknown>;
    readonly entityId?: string;
  },
): Promise<void> {
  await ctx.store.create('execution_log', {
    handler: opts.handler,
    source: ctx.entity,
    entity_id: opts.entityId ?? resolveEntityId(ctx),
    status: 'completed',
    timestamp: new Date().toISOString(),
    duration: Math.round(performance.now() - ctx.startedAt),
    retention: opts.retention,
    payload: opts.payload,
    createdBy: ctx.identity.id,
    updatedBy: ctx.identity.id,
  });
}
