/**
 * emit-broker — Write event to emit_records + notify broker.
 *
 * Transactional for writes. Creates a domain event record and notifies
 * the broker so subscription processors can react.
 *
 * STABLE — ADR 05 invariant.
 *
 * UPDATE @ M7: emit_records entity becomes a real framework entity that the
 * subscription processor reads with a cursor. The `event` object below
 * will be written to the store at that point.
 */

import type { ExecutionHandler, EntityRecord } from '@janus/core';

/** Map operation -> event descriptor kind */
function operationToDescriptorKind(operation: string): string {
  switch (operation) {
    case 'create': return 'created';
    case 'update': return 'updated';
    case 'delete': return 'deleted';
    default: return 'acted';
  }
}

export const emitBroker: ExecutionHandler = async (ctx) => {
  // Skip event emission for internal dispatches to prevent duplicate events
  if (ctx.depth > 0) return;

  const descriptor = operationToDescriptorKind(ctx.operation);
  const entityId = ctx.result?.kind === 'record'
    ? (ctx.result.record as EntityRecord).id
    : undefined;

  // M7: write domain event to emit_records store here
  // (source, entityId, descriptor, identity snapshot, correlationId, timestamp)

  // Notify broker (if wired)
  if (ctx.broker) {
    ctx.broker.notify({
      entity: ctx.entity,
      entityId,
      descriptor,
      correlationId: ctx.correlationId,
    });
  }
};
