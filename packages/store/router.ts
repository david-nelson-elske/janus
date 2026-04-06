/**
 * Store router — dispatches EntityStore operations to the correct adapter
 * based on persist_routing records from compile().
 *
 * STABLE — the routing pattern (entity name → adapter via routing records) is
 * an ADR-124 invariant. The router reads from CompileResult.persistRouting.
 *
 * UPDATE @ M4+: When persist_routing becomes a real Derived entity, the router
 * may read routing from the store instead of from compile output.
 */

import type { RoutingRecord, EntityStore, EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { StoreAdapter, TransactionalAdapter, AdapterMeta } from './store-adapter';
import type { ReconcilableAdapter } from './store-adapter';

export interface EntityStoreConfig {
  readonly routing: readonly RoutingRecord[];
  readonly adapters: {
    readonly relational?: ReconcilableAdapter;
    readonly memory?: StoreAdapter;
    readonly derived?: StoreAdapter;
  };
  /** Entities acknowledged for removal via drop(). */
  readonly drops?: ReadonlySet<string>;
}

export function createEntityStore(config: EntityStoreConfig): EntityStore {
  // Build lookup: entity name → { adapter, meta }
  const routeMap = new Map<string, { adapter: StoreAdapter; meta: AdapterMeta }>();

  for (const route of config.routing) {
    const adapter = resolveAdapter(route.adapter, config.adapters);
    if (!adapter) {
      throw new Error(
        `No adapter registered for '${route.adapter}' (entity: '${route.entity}')`,
      );
    }
    routeMap.set(route.entity, {
      adapter,
      meta: {
        entity: route.entity,
        table: route.table,
        schema: route.schema,
        storage: route.storage,
        indexes: route.indexes,
        evolve: route.evolve,
      },
    });
  }

  function resolve(entity: string): { adapter: StoreAdapter; meta: AdapterMeta } {
    const entry = routeMap.get(entity);
    if (!entry) {
      throw new Error(`Unknown entity: '${entity}'. Not found in persist_routing.`);
    }
    return entry;
  }

  const store: EntityStore = {
    async read(entity: string, params?: ReadParams): Promise<EntityRecord | ReadPage> {
      const { adapter, meta } = resolve(entity);
      return adapter.read(meta, params);
    },

    async create(entity: string, record: NewEntityRecord): Promise<EntityRecord> {
      const { adapter, meta } = resolve(entity);
      return adapter.create(meta, record);
    },

    async update(entity: string, id: string, patch: Record<string, unknown>, options?: UpdateOptions): Promise<EntityRecord> {
      const { adapter, meta } = resolve(entity);
      return adapter.update(meta, id, patch, options);
    },

    async delete(entity: string, id: string): Promise<void> {
      const { adapter, meta } = resolve(entity);
      return adapter.delete(meta, id);
    },

    async count(entity: string, where: Record<string, unknown>): Promise<number> {
      const { adapter, meta } = resolve(entity);
      return adapter.count(meta, where);
    },

    async updateWhere(entity: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number> {
      const { adapter, meta } = resolve(entity);
      return adapter.updateWhere(meta, where, patch);
    },

    async withTransaction<T>(fn: (tx: EntityStore) => Promise<T>): Promise<T> {
      // Delegate to the relational adapter's transaction
      const relational = config.adapters.relational;
      if (!relational) {
        // No transactional adapter — run without transaction
        return fn(store);
      }
      return relational.withTransaction(async (txAdapter) => {
        // Build a transactional store that uses the tx adapter for relational entities
        // and the regular memory adapter for volatile entities
        function resolveTx(entity: string) {
          const { adapter, meta } = resolve(entity);
          return { meta, useTx: adapter === relational };
        }

        const txStore: EntityStore = {
          async read(entity, params) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.read(meta, params) : store.read(entity, params);
          },
          async create(entity, record) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.create(meta, record) : store.create(entity, record);
          },
          async update(entity, id, patch, options) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.update(meta, id, patch, options) : store.update(entity, id, patch, options);
          },
          async delete(entity, id) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.delete(meta, id) : store.delete(entity, id);
          },
          async count(entity, where) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.count(meta, where) : store.count(entity, where);
          },
          async updateWhere(entity, where, patch) {
            const { meta, useTx } = resolveTx(entity);
            return useTx ? txAdapter.updateWhere(meta, where, patch) : store.updateWhere(entity, where, patch);
          },
          withTransaction: (innerFn) => innerFn(txStore),
          initialize: async () => {},
        } as EntityStore;

        return fn(txStore);
      });
    },

    async initialize(): Promise<void> {
      for (const { adapter, meta } of routeMap.values()) {
        await adapter.initialize(meta);
      }

      if (config.adapters.relational) {
        await config.adapters.relational.finalize(config.drops);
      }
    },
  };

  return store;
}

function resolveAdapter(
  adapterKind: string,
  adapters: EntityStoreConfig['adapters'],
): StoreAdapter | undefined {
  switch (adapterKind) {
    case 'relational':
      return adapters.relational;
    case 'memory':
      return adapters.memory;
    case 'derived':
      return adapters.derived;
    default:
      return undefined;
  }
}
