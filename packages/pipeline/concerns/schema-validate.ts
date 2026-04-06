/**
 * schema-validate — Schema + lifecycle validation.
 *
 * STABLE — validate logic is an ADR-05 invariant. Checks lifecycle transition
 * legality and fetches before-record for update/delete.
 *
 * UPDATE @ M4 (ADR 01b): Add ownership enforcement when policyOwnershipField is set.
 */

import type { ExecutionHandler } from '@janus/core';
import { isReadPage } from '@janus/core';

export const schemaValidate: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  if (!entity) return;

  const parsed = ctx.parsed;
  if (!parsed) return;

  // For update/delete, fetch the before-record
  if (ctx.operation === 'update' || ctx.operation === 'delete') {
    const id = parsed.id as string;
    if (!id) {
      throw Object.assign(new Error('Missing id for update/delete'), {
        kind: 'parse-error',
        retryable: false,
      });
    }
    const before = await ctx.store.read(ctx.entity, { id });
    if (!before || isReadPage(before)) {
      throw Object.assign(new Error(`Entity '${ctx.entity}' record '${id}' not found`), {
        kind: 'not-found',
        retryable: false,
      });
    }
    ctx.before = before;
  }

  // Lifecycle transition validation
  if (ctx.operation === 'update' && entity.lifecycles.length > 0) {
    for (const { field, lifecycle } of entity.lifecycles) {
      if (field in parsed) {
        const targetState = parsed[field] as string;
        const currentState = ctx.before?.[field] as string | undefined;

        if (currentState) {
          const allowedTargets = lifecycle.transitions[currentState];
          if (!allowedTargets || !allowedTargets.includes(targetState)) {
            throw Object.assign(
              new Error(
                `Invalid lifecycle transition on '${field}': '${currentState}' → '${targetState}'`,
              ),
              { kind: 'lifecycle-violation', retryable: false },
            );
          }
        }
      }
    }
  }

  // Stamp lifecycle initial values on create
  if (ctx.operation === 'create') {
    for (const { field, lifecycle } of entity.lifecycles) {
      if (!(field in parsed)) {
        parsed[field] = lifecycle.initial;
      }
    }
  }

  // Asset field validation — verify referenced asset IDs exist (ADR 08b)
  if (ctx.operation === 'create' || ctx.operation === 'update') {
    const assetIds: { field: string; id: string }[] = [];
    for (const [field, def] of Object.entries(entity.schema)) {
      if ('kind' in def && def.kind === 'asset' && field in parsed) {
        const val = parsed[field];
        if (typeof val === 'string' && val.length > 0) {
          assetIds.push({ field, id: val });
        }
      }
    }
    if (assetIds.length > 0) {
      for (const { field, id } of assetIds) {
        let exists = false;
        try {
          const assetRecord = await ctx.store.read('asset', { id });
          exists = !!assetRecord && !isReadPage(assetRecord);
        } catch {
          // Store throws on not-found — treat as missing
        }
        if (!exists) {
          throw Object.assign(
            new Error(`Asset '${id}' referenced by field '${field}' not found`),
            { kind: 'validation-error', retryable: false },
          );
        }
      }
    }
  }

  ctx.validated = true;
};
