/**
 * createApp() — Full application bootstrap.
 *
 * Replaces the demo's manual boot sequence. Handles registration, compilation,
 * store setup, broker, subscription processor, and HTTP surface wiring.
 *
 * Serving is the consumer's concern — use app.fetch() for testing or pass it
 * to your runtime's serve function (Bun.serve, Deno.serve, @hono/node-server).
 *
 * UPDATE @ M8-render: Add connection manager, broker SSE bridge, and page serving.
 */

import type {
  AssetBackend,
  CompileResult,
  DeclarationRecord,
  DispatchResponse,
  EntityStore,
  Identity,
  InitiatorConfig,
} from '@janus/core';
import { compile, SYSTEM } from '@janus/core';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  startSubscriptionProcessor,
  frameworkEntities,
  frameworkParticipations,
  createConnectionManager,
  startBrokerSseBridge,
} from '@janus/pipeline';
import type { DispatchRuntime, Broker, ConnectionManager } from '@janus/pipeline';
import { createSqliteAdapter, createMemoryAdapter, createDerivedAdapter, createEntityStore } from '@janus/store';
import { Hono } from 'hono';
import { createHttpApp } from './hono-app';
import { apiSurface } from './surface';

export interface AppConfig {
  readonly declarations: readonly DeclarationRecord[];
  readonly surfaces?: readonly ReturnType<typeof apiSurface>[];
  readonly store?: { readonly path?: string };
  /** Asset storage backend (ADR 08b). When set, enables upload/serving routes. */
  readonly assetBackend?: AssetBackend;
  /** Enable SSE connection management and real-time sync. Default: true when surfaces exist. */
  readonly enableSse?: boolean;
  /** Enable SSR page serving. Default: true when bindings exist. */
  readonly enablePages?: boolean;
  /** Schema reconciliation mode. Default: 'auto'. Use 'skip' after manual applyReconciliation(). */
  readonly reconciliation?: 'auto' | 'skip';
}

export interface App {
  readonly registry: CompileResult;
  readonly store: EntityStore;
  readonly runtime: DispatchRuntime;
  readonly broker: Broker;
  readonly connectionManager: ConnectionManager;
  dispatch(entity: string, operation: string, input: unknown, identity?: Identity): Promise<DispatchResponse>;
  fetch(request: Request): Promise<Response>;
  shutdown(): Promise<void>;
}

export async function createApp(config: AppConfig): Promise<App> {
  // Phase 0: Register handler implementations and create connection manager
  registerHandlers();
  const connectionManager = createConnectionManager();

  // Phase 1: Compile
  const initiators: InitiatorConfig[] = [];
  const surfaceConfigs: { initiator: InitiatorConfig; basePath: string }[] = [];

  if (config.surfaces) {
    for (const s of config.surfaces) {
      initiators.push(s.initiator);
      surfaceConfigs.push(s);
    }
  }

  const registry = compile(
    [
      ...config.declarations,
      ...frameworkEntities,
      ...frameworkParticipations,
    ],
    initiators,
  );

  // Phase 2: Store initialization
  const sqliteAdapter = createSqliteAdapter({
    path: config.store?.path ?? ':memory:',
  });
  const memoryAdapter = createMemoryAdapter();

  // Lazy store ref for derived adapter (it needs to read from the store it's part of)
  let storeRef: import('@janus/core').EntityStore;
  const derivedAdapter = createDerivedAdapter({ getStore: () => storeRef });

  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: {
      relational: sqliteAdapter,
      memory: memoryAdapter,
      derived: derivedAdapter,
    },
    drops: registry.drops,
  });
  storeRef = store;

  await store.initialize();

  // Phase 3: Runtime
  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry, store, broker, assetBackend: config.assetBackend });

  // Phase 4: Subscription processor
  const subscriptionHandle = startSubscriptionProcessor({ runtime, broker, store, registry });

  // Phase 5: Broker → SSE bridge
  const enableSse = config.enableSse ?? (surfaceConfigs.length > 0);
  let sseBridgeUnsub: (() => void) | undefined;
  if (enableSse) {
    sseBridgeUnsub = startBrokerSseBridge({ broker, connectionManager, store });
  }

  // Phase 6: HTTP
  let honoApp: Hono;
  if (surfaceConfigs.length > 0) {
    honoApp = createHttpApp({
      registry,
      runtime,
      surfaces: surfaceConfigs,
      connectionManager: enableSse ? connectionManager : undefined,
      assetBackend: config.assetBackend,
      enablePages: config.enablePages,
    });
  } else {
    honoApp = new Hono();
  }

  return {
    registry,
    store,
    runtime,
    broker,
    connectionManager,

    dispatch(entity, operation, input, identity) {
      return runtime.dispatch('system', entity, operation, input, identity ?? SYSTEM);
    },

    async fetch(request: Request) {
      return honoApp.fetch(request);
    },

    async shutdown() {
      subscriptionHandle.unsubscribe();
      if (sseBridgeUnsub) sseBridgeUnsub();
      // Close all SSE connections
      for (const conn of connectionManager.all()) {
        connectionManager.remove(conn.id);
      }
    },
  };
}
