/**
 * Demo app boot sequence.
 *
 * Compiles demo entities, creates SQLite store, initializes tables,
 * and returns a dispatch-ready runtime.
 */

import { compile } from '@janus/core';
import type { CompileResult, InitiatorConfig } from '@janus/core';
import { createSqliteAdapter, createMemoryAdapter, createDerivedAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import { registerHandlers, createDispatchRuntime, createBroker, startSubscriptionProcessor, startScheduler, frameworkEntities, frameworkParticipations } from '@janus/pipeline';
import type { DispatchRuntime, Broker } from '@janus/pipeline';
import type { SubscriptionProcessorHandle, SchedulerHandle } from '@janus/pipeline';
import { allDefinitions, wireTaskSummaryStore } from './entities';
import { allParticipations } from './participation';
import { allSubscriptions } from './subscriptions';
import { allBindings } from './bindings';

export interface BootConfig {
  readonly dbPath?: string;
  readonly initiators?: readonly InitiatorConfig[];
}

export interface DemoApp {
  readonly runtime: DispatchRuntime;
  readonly store: EntityStore;
  readonly registry: CompileResult;
  readonly broker: Broker;
  readonly subscriptions: SubscriptionProcessorHandle;
  readonly scheduler: SchedulerHandle;
}

/**
 * Boot the demo app.
 * @param configOrDbPath Boot config or path to the SQLite database file.
 */
export async function boot(configOrDbPath?: string | BootConfig): Promise<DemoApp> {
  const config: BootConfig = typeof configOrDbPath === 'string'
    ? { dbPath: configOrDbPath }
    : configOrDbPath ?? {};

  // 1. Register real handler implementations
  registerHandlers();

  // 2. Compile all declarations (consumer + framework entities + subscriptions)
  const registry = compile(
    [
      ...allDefinitions,
      ...allParticipations,
      ...allSubscriptions,
      ...allBindings,
      ...frameworkEntities,
      ...frameworkParticipations,
    ],
    config.initiators as InitiatorConfig[] | undefined,
  );

  // 3. Create store adapters
  const sqliteAdapter = createSqliteAdapter({
    path: config.dbPath ?? 'examples/dev-app/janus.db',
  });
  const memoryAdapter = createMemoryAdapter();

  // Lazy store ref for derived adapter
  let storeRef: EntityStore;
  const derivedAdapter = createDerivedAdapter({ getStore: () => storeRef });

  // 4. Create routed entity store
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: {
      relational: sqliteAdapter,
      memory: memoryAdapter,
      derived: derivedAdapter,
    },
  });
  storeRef = store;

  // 5. Initialize (create tables) + wire derived entity store refs
  await store.initialize();
  wireTaskSummaryStore(store);

  // 6. Create broker + dispatch runtime
  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry, store, broker });

  // 7. Start subscription processor (event-triggered subscriptions)
  const subscriptions = startSubscriptionProcessor({ runtime, broker, store, registry });

  // 8. Start scheduler (cron-triggered subscriptions)
  const scheduler = startScheduler({ runtime, store, registry });

  return { runtime, store, registry, broker, subscriptions, scheduler };
}
