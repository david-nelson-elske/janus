/**
 * connector-distribute — subscription adapter that pushes entity changes to external systems.
 *
 * ADR 07c: Connectors are entities, not a framework primitive. This handler is wired via
 * subscribe() on the target entity. On entity mutation events, it:
 * 1. Reads the triggering entity record
 * 2. Looks up existing connector_binding for this record
 * 3. Maps fields, filters by field ownership if present
 * 4. Calls the consumer-provided push function
 * 5. Creates or updates the connector_binding with the external ID
 *
 * UPDATE: Multi-source support (externalSource), per-field ownership filtering.
 */

import type { ExecutionHandler, EntityRecord, ReadPage } from '@janus/core';
import { SYSTEM, isReadPage } from '@janus/core';
import { filterForDistribute } from '../connector-merge';
import type { FieldOwnershipMap } from '../connector-merge';

export const connectorDistribute: ExecutionHandler = async (ctx) => {
  const config = ctx.config as Record<string, unknown>;
  const connector = config.connector as string;
  const targetEntity = (config.targetEntity ?? ctx.entity) as string;
  const mapFields = config.mapFields as ((record: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const push = config.push as ((mapped: Record<string, unknown>, binding: Record<string, unknown> | null) => Promise<{ externalId: string }>) | undefined;
  const externalSource = (config.externalSource ?? connector) as string;
  const configDirection = config.direction as string | undefined;
  const configFieldOwnership = config.fieldOwnership as FieldOwnershipMap | undefined;

  if (!connector) {
    throw Object.assign(new Error('connector-distribute: missing connector in config'), {
      kind: 'config-error', retryable: false,
    });
  }
  if (!push) {
    throw Object.assign(new Error('connector-distribute: missing push function in config'), {
      kind: 'config-error', retryable: false,
    });
  }

  // Read the triggering entity record.
  // Subscription processor passes { entity, entityId, descriptor } directly.
  const triggerInput = ctx.input as Record<string, unknown> | undefined;
  const entityId = (triggerInput?.entityId ?? triggerInput?._trigger?.entityId) as string | undefined;
  if (!entityId) {
    // No entity ID in trigger — this is a broadcast event, skip
    return;
  }

  let record: EntityRecord;
  try {
    const result = await ctx.store.read(targetEntity, { id: entityId });
    if (isReadPage(result)) return;
    record = result as EntityRecord;
  } catch (err) {
    // not-found is expected (record deleted between event and handler execution)
    const kind = (err as { kind?: string })?.kind;
    if (kind !== 'not-found') {
      console.warn(`[connector-distribute] Failed to read ${targetEntity}/${entityId}:`, err instanceof Error ? err.message : err);
    }
    return;
  }

  // Two-phase binding lookup: with externalSource, then legacy fallback
  let existingBinding: EntityRecord | null = null;
  let isLegacyBinding = false;

  const bindingPage = await ctx.store.read('connector_binding', {
    where: {
      connector,
      entity: targetEntity,
      localId: entityId,
      externalSource,
    },
  }) as ReadPage;
  existingBinding = bindingPage.records[0] ?? null;

  if (!existingBinding) {
    // Legacy fallback: look up without externalSource (null bindings from before multi-source)
    const legacyPage = await ctx.store.read('connector_binding', {
      where: {
        connector,
        entity: targetEntity,
        localId: entityId,
      },
    }) as ReadPage;
    // Only use legacy match if it has no externalSource set
    const legacyMatch = legacyPage.records.find((r) => !r.externalSource);
    if (legacyMatch) {
      existingBinding = legacyMatch;
      isLegacyBinding = true;
    }
  }

  // Map fields
  const mapped = mapFields
    ? mapFields(record as unknown as Record<string, unknown>)
    : { ...record };

  // Apply field ownership filtering if present on the binding or config
  const ownership = (existingBinding?.fieldOwnership as FieldOwnershipMap | undefined) ?? configFieldOwnership;
  let toPush = mapped;
  if (ownership) {
    const filtered = filterForDistribute(mapped, ownership);
    if (!filtered.hasPushableFields) return; // Nothing local-owned to push
    toPush = filtered.fields;
  }

  // Push to external system
  let externalId: string;
  try {
    ({ externalId } = await push(toPush, existingBinding as unknown as Record<string, unknown>));
  } catch (err) {
    throw Object.assign(
      new Error(`connector-distribute: push failed for ${connector}/${targetEntity}/${entityId}: ${err instanceof Error ? err.message : err}`),
      { kind: 'connector-push-error', retryable: true, cause: err },
    );
  }

  const now = new Date().toISOString();

  if (existingBinding) {
    const patch: Record<string, unknown> = {
      id: existingBinding.id,
      lastSyncedAt: now,
      watermark: now,
    };
    // Backfill externalSource on legacy bindings
    if (isLegacyBinding) {
      patch.externalSource = externalSource;
    }
    if (ctx._dispatch) {
      await ctx._dispatch('connector_binding', 'update', patch, SYSTEM);
    }
  } else {
    // Create new binding
    if (ctx._dispatch) {
      await ctx._dispatch('connector_binding', 'create', {
        connector,
        entity: targetEntity,
        localId: entityId,
        externalId,
        externalSource,
        direction: configDirection ?? 'distribute',
        lastSyncedAt: now,
        watermark: now,
        ...(configFieldOwnership ? { fieldOwnership: configFieldOwnership } : {}),
      }, SYSTEM);
    }
  }
};
