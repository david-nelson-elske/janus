/**
 * Core CRUD handlers — store-read, store-create, store-update, store-delete.
 *
 * STABLE — these are the order=35 core handlers that interact with the EntityStore.
 * Each sets ctx.result with the appropriate PersistResult variant.
 *
 * M4: store-create stamps createdBy from identity. store-update stamps updatedBy.
 * ADR 01d: store-delete enriched with restrict/cascade/nullify. store-update enriched
 *          with transition effects.
 */

import type { ExecutionHandler, EntityRecord, ReadPage } from '@janus/core';
import { isReadPage } from '@janus/core';
import { dispatchToReferencing, applyTransitionEffect } from './store-effects';

/** Read entity records — single by id or filtered page. */
export const storeRead: ExecutionHandler = async (ctx) => {
  const input = (ctx.parsed ?? ctx.input ?? {}) as Record<string, unknown>;
  // `lang` is read off the raw input — schema-parse strips non-entity fields,
  // so the active language never makes it into ctx.parsed even though
  // create/update need it for write-time column routing.
  const rawInput = (ctx.input ?? {}) as Record<string, unknown>;
  const id = input.id as string | undefined;
  const entity = ctx.registry.entity(ctx.entity);

  // Build read params
  const where = (input.where as Record<string, unknown>) ?? {};

  // Ownership scoping: if entity is owned, filter by createdBy = identity.id
  // unless the caller has 'admin' or 'system' role
  if (entity?.owned && !ctx.identity.roles.includes('admin') && ctx.identity.id !== 'system') {
    where.createdBy = ctx.identity.id;
  }

  const lang = (input.lang ?? rawInput.lang) as string | undefined;
  const readParams = id
    ? { id, lang }
    : {
        where: Object.keys(where).length > 0 ? where : undefined,
        sort: input.sort as { field: string; direction: 'asc' | 'desc' }[] | undefined,
        limit: input.limit as number | undefined,
        offset: input.offset as number | undefined,
        search: input.search as string | undefined,
        lang,
      };

  const result = await ctx.store.read(ctx.entity, readParams);

  // For owned entities, verify single-record reads belong to the caller
  if (entity?.owned && id && !ctx.identity.roles.includes('admin') && ctx.identity.id !== 'system') {
    if (!isReadPage(result)) {
      const record = result as EntityRecord;
      if (record.createdBy !== ctx.identity.id) {
        throw Object.assign(new Error(`Access denied: record belongs to another user`), {
          kind: 'auth-error',
          retryable: false,
        });
      }
    }
  }

  if (isReadPage(result)) {
    ctx.result = { kind: 'page', page: result as ReadPage };
  } else {
    ctx.result = { kind: 'record', record: result as EntityRecord };
  }
};

/** Create a new entity record. Stamps createdBy/updatedBy from dispatch identity.
 *  Forwards the dispatch-level `lang` flag as `__lang` so adapters can route
 *  Translatable() values into the matching parallel column. */
export const storeCreate: ExecutionHandler = async (ctx) => {
  const parsed = (ctx.parsed ?? {}) as Record<string, unknown>;
  const input: Record<string, unknown> = {
    ...parsed,
    createdBy: ctx.identity.id,
    updatedBy: ctx.identity.id,
  };
  const langHint = parsed.lang ?? (ctx.input as Record<string, unknown> | undefined)?.lang;
  if (typeof langHint === 'string' && langHint.length > 0) {
    input.__lang = langHint;
  }
  const record = await ctx.store.create(ctx.entity, input);
  ctx.result = { kind: 'record', record };
};

/** Update an existing entity record. Stamps updatedBy from dispatch identity.
 *  ADR 01d: After update, if a lifecycle field transitioned, apply transition effects. */
export const storeUpdate: ExecutionHandler = async (ctx) => {
  const input = ctx.parsed ?? {};
  const { id, ...patch } = input;
  if (!id) {
    throw Object.assign(new Error('Missing id for update'), {
      kind: 'parse-error',
      retryable: false,
    });
  }

  // Ownership check: verify the target record belongs to the caller
  const entity = ctx.registry.entity(ctx.entity);
  if (entity?.owned && !ctx.identity.roles.includes('admin') && ctx.identity.id !== 'system') {
    const existing = await ctx.store.read(ctx.entity, { id: id as string });
    if (!isReadPage(existing)) {
      const rec = existing as EntityRecord;
      if (rec.createdBy !== ctx.identity.id) {
        throw Object.assign(new Error('Access denied: record belongs to another user'), {
          kind: 'auth-error',
          retryable: false,
        });
      }
    }
  }

  const updatePayload: Record<string, unknown> = {
    ...patch,
    updatedBy: ctx.identity.id,
  };
  const langHint = (input as Record<string, unknown>).lang
    ?? (ctx.input as Record<string, unknown> | undefined)?.lang;
  if (typeof langHint === 'string' && langHint.length > 0) {
    updatePayload.__lang = langHint;
  }
  const record = await ctx.store.update(ctx.entity, id as string, updatePayload);
  ctx.result = { kind: 'record', record };

  // ── Transition effects (ADR 01d) ──────────────────────────────
  if (entity && ctx.before && ctx._dispatch) {
    for (const { field } of entity.lifecycles) {
      const oldState = ctx.before[field] as string | undefined;
      const newState = record[field] as string | undefined;
      if (oldState && newState && oldState !== newState) {
        const effectEdges = ctx.registry.wiring.reverseEffects(ctx.entity);
        for (const edge of effectEdges) {
          const transitionEffects = edge.effects?.transitioned;
          if (!transitionEffects) continue;
          const action = transitionEffects[newState];
          if (!action) continue;
          await applyTransitionEffect(ctx, edge, action, id as string);
        }
      }
    }
  }
};

/** Delete an entity record. Captures before-record for audit.
 *  ADR 01d: Before delete, check restrict. After delete, apply cascade/nullify. */
export const storeDelete: ExecutionHandler = async (ctx) => {
  const input = ctx.parsed ?? ctx.input as Record<string, unknown>;
  const id = input?.id as string;
  if (!id) {
    throw Object.assign(new Error('Missing id for delete'), {
      kind: 'parse-error',
      retryable: false,
    });
  }

  // Fetch before-record so audit can capture what was deleted.
  if (!ctx.before) {
    const existing = await ctx.store.read(ctx.entity, { id });
    if (!isReadPage(existing)) {
      ctx.before = existing as EntityRecord;
    }
  }

  // Ownership check: verify the target record belongs to the caller
  const entity = ctx.registry.entity(ctx.entity);
  if (entity?.owned && !ctx.identity.roles.includes('admin') && ctx.identity.id !== 'system') {
    const target = ctx.before;
    if (target && target.createdBy !== ctx.identity.id) {
      throw Object.assign(new Error('Access denied: record belongs to another user'), {
        kind: 'auth-error',
        retryable: false,
      });
    }
  }

  // ── Wiring effects on delete (ADR 01d) ────────────────────────
  const effectEdges = ctx.registry.wiring.reverseEffects(ctx.entity);

  // 1. Restrict check — before the delete
  for (const edge of effectEdges) {
    if (edge.effects?.deleted === 'restrict') {
      const count = await ctx.store.count(edge.from, { [edge.fromField]: id });
      if (count > 0) {
        throw Object.assign(
          new Error(
            `Cannot delete '${ctx.entity}' ${id}: ${count} '${edge.from}' record(s) reference it via '${edge.fromField}'`,
          ),
          { kind: 'restrict-violation', retryable: false },
        );
      }
    }
  }

  // 2. Perform the actual delete
  await ctx.store.delete(ctx.entity, id);

  // 3. Cascade — delete referencing records via re-entrant dispatch
  //    Propagate caller identity so ownership checks apply on child records.
  for (const edge of effectEdges) {
    if (edge.effects?.deleted === 'cascade') {
      await dispatchToReferencing(ctx, edge, id, 'delete',
        (r) => ({ id: r.id }), 'Cascade delete of', ctx.identity);
    }
  }

  // 4. Nullify — direct store access, no dispatch, no events
  for (const edge of effectEdges) {
    if (edge.effects?.deleted === 'nullify') {
      await ctx.store.updateWhere(edge.from, { [edge.fromField]: id }, { [edge.fromField]: null });
    }
  }

  ctx.result = { kind: 'void' };
};
