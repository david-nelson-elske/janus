/**
 * Wiring effect helpers for store CRUD handlers.
 *
 * ADR 01d: cascade/restrict/nullify on delete, transition effects on update.
 * These are dispatched by store-handlers after the core CRUD operation.
 */

import type { ExecutionHandler, EntityRecord, ReadPage, WiringEdge } from '@janus/core';
import { SYSTEM } from '@janus/core';

/** Dispatch an operation to all records referencing `entityId` via `edge`, with pagination. */
export async function dispatchToReferencing(
  ctx: Parameters<ExecutionHandler>[0],
  edge: WiringEdge,
  entityId: string,
  operation: string,
  buildInput: (record: EntityRecord) => Record<string, unknown>,
  errorLabel: string,
): Promise<void> {
  if (!ctx._dispatch) return;
  let offset = 0;
  const limit = 200;
  // biome-ignore lint/correctness/noConstantCondition: pagination loop
  while (true) {
    const page = await ctx.store.read(edge.from, {
      where: { [edge.fromField]: entityId }, limit, offset,
    }) as ReadPage;
    for (const record of page.records) {
      const resp = await ctx._dispatch(edge.from, operation, buildInput(record), SYSTEM);
      if (!resp.ok) {
        throw Object.assign(
          new Error(`${errorLabel} '${edge.from}' ${record.id} failed: ${resp.error?.message ?? 'unknown error'}`),
          { kind: resp.error?.kind ?? 'cascade-error', retryable: false },
        );
      }
    }
    if (!page.hasMore) break;
    offset += limit;
  }
}

/** Apply a single transition effect from an inbound edge. */
export async function applyTransitionEffect(
  ctx: Parameters<ExecutionHandler>[0],
  edge: WiringEdge,
  action: 'nullify' | 'cascade' | { readonly transition: string },
  entityId: string,
): Promise<void> {
  if (action === 'nullify') {
    await ctx.store.updateWhere(edge.from, { [edge.fromField]: entityId }, { [edge.fromField]: null });
  } else if (action === 'cascade') {
    await dispatchToReferencing(ctx, edge, entityId, 'delete',
      (r) => ({ id: r.id }), 'Cascade delete of');
  } else if (typeof action === 'object' && action.transition) {
    const sourceEntity = ctx.registry.entity(edge.from);
    if (!sourceEntity) return;
    const lifecycleField = sourceEntity.lifecycles[0]?.field;
    if (!lifecycleField) return;
    await dispatchToReferencing(ctx, edge, entityId, 'update',
      (r) => ({ id: r.id, [lifecycleField]: action.transition }), 'Transition of');
  }
}
