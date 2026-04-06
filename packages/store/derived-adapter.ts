/**
 * Derived adapter — read-only computed entities.
 *
 * Two modes:
 * - Simple derived: { from, where } — delegates reads to the source entity with a static filter.
 * - Computed derived: { compute } — calls a function that returns records on demand.
 *
 * All write operations throw readOnlyEntity().
 */

import { isDerived } from '@janus/vocabulary';
import type { DerivedStrategy, SimpleDerivedConfig, ComputeDerivedConfig } from '@janus/vocabulary';
import type { EntityRecord, ReadPage, ReadParams, NewEntityRecord, UpdateOptions, EntityStore } from '@janus/core';
import type { StoreAdapter, AdapterMeta } from './store-adapter';
import { readOnlyEntity, entityNotFound } from './errors';

function isSimpleDerived(config: DerivedStrategy['config']): config is SimpleDerivedConfig {
  return 'from' in config;
}

function isComputeDerived(config: DerivedStrategy['config']): config is ComputeDerivedConfig {
  return 'compute' in config;
}

export interface DerivedAdapterConfig {
  /** Lazy reference to the entity store — needed for simple derived entities to read source. */
  readonly getStore: () => EntityStore;
}

export function createDerivedAdapter(config: DerivedAdapterConfig): StoreAdapter {
  const { getStore } = config;

  return {
    async initialize(): Promise<void> {
      // No-op — derived entities have no storage to initialize.
    },

    async read(meta: AdapterMeta, params?: ReadParams): Promise<EntityRecord | ReadPage> {
      const storage = meta.storage as DerivedStrategy;
      const derivedConfig = storage.config;

      if (isComputeDerived(derivedConfig)) {
        return computeRead(derivedConfig, meta, params);
      }

      if (isSimpleDerived(derivedConfig)) {
        return simpleRead(derivedConfig, meta, params, getStore());
      }

      throw new Error(`Unknown derived config for '${meta.entity}'`);
    },

    async create(meta: AdapterMeta): Promise<EntityRecord> {
      throw readOnlyEntity(meta.entity, 'create');
    },

    async update(meta: AdapterMeta): Promise<EntityRecord> {
      throw readOnlyEntity(meta.entity, 'update');
    },

    async delete(meta: AdapterMeta): Promise<void> {
      throw readOnlyEntity(meta.entity, 'delete');
    },

    async count(meta: AdapterMeta, where: Record<string, unknown>): Promise<number> {
      const storage = meta.storage as DerivedStrategy;
      const derivedConfig = storage.config;

      if (isSimpleDerived(derivedConfig)) {
        const merged = { ...derivedConfig.where, ...where };
        return getStore().count(derivedConfig.from, merged);
      }

      // For computed: read all and count
      const result = await this.read(meta, { where });
      if ('records' in (result as ReadPage)) {
        return (result as ReadPage).total;
      }
      return 1;
    },

    async updateWhere(meta: AdapterMeta): Promise<number> {
      throw readOnlyEntity(meta.entity, 'updateWhere');
    },
  };
}

// ── Simple derived: delegate to source entity ──────────────────

async function simpleRead(
  config: SimpleDerivedConfig,
  meta: AdapterMeta,
  params: ReadParams | undefined,
  store: EntityStore,
): Promise<EntityRecord | ReadPage> {
  const mergedWhere = { ...config.where, ...(params?.where as Record<string, unknown> ?? {}) };
  const mergedParams: ReadParams = {
    ...params,
    where: mergedWhere,
  };

  // Apply sort from derived config if no explicit sort
  if (config.sort && !params?.sort) {
    mergedParams.sort = Object.entries(config.sort).map(([field, direction]) => ({
      field,
      direction,
    }));
  }

  // Single record by ID: verify it matches the static filter
  if (params?.id) {
    const record = await store.read(config.from, { id: params.id }) as EntityRecord;
    for (const [field, value] of Object.entries(config.where)) {
      if (record[field] !== value) {
        throw entityNotFound(meta.entity, params.id);
      }
    }
    return record;
  }

  return store.read(config.from, mergedParams);
}

// ── Computed derived: call compute function ────────────────────

async function computeRead(
  config: ComputeDerivedConfig,
  meta: AdapterMeta,
  params: ReadParams | undefined,
): Promise<EntityRecord | ReadPage> {
  const result = await config.compute(params ?? {}, {});

  // If compute returns an array, wrap it in a ReadPage
  if (Array.isArray(result)) {
    const records = result as EntityRecord[];
    return {
      records,
      total: records.length,
      hasMore: false,
      offset: 0,
      limit: records.length,
    };
  }

  // If it returns a ReadPage, pass through
  if (result && typeof result === 'object' && 'records' in (result as object)) {
    return result as ReadPage;
  }

  // If it returns a single record
  return result as EntityRecord;
}
