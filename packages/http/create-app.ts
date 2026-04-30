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
  EntityRecord,
  EntityStore,
  Identity,
  InitiatorConfig,
  ParticipationRecord,
} from '@janus/core';
import { compile, isReadPage, SYSTEM } from '@janus/core';
import type { Broker, ConnectionManager, DispatchRuntime, OidcConfig } from '@janus/pipeline';
import {
  createBroker,
  createConnectionManager,
  createDispatchRuntime,
  frameworkEntities,
  frameworkParticipations,
  registerHandlers,
  startBrokerSseBridge,
  startSubscriptionProcessor,
} from '@janus/pipeline';
import {
  createDerivedAdapter,
  createEntityStore,
  createMemoryAdapter,
  createSqliteAdapter,
} from '@janus/store';
import { Hono } from 'hono';
import type { OidcProviderRecord } from './auth-routes';
import { createAuthRoutes } from './auth-routes';
import { createHttpApp } from './hono-app';
import type { apiSurface } from './surface';

export interface AppConfig {
  readonly declarations: readonly DeclarationRecord[];
  /** HTTP surface configuration. When set, derives API routes at the given basePath. */
  readonly http?: { readonly basePath?: string };
  /** API key → Identity map for dev/testing. Used by the HTTP identity handler. */
  readonly apiKeys?: Readonly<Record<string, Identity>>;
  /** @deprecated Use `http` and `apiKeys` instead. Kept for backward compatibility. */
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
  /** Additional initiators (e.g., agent surfaces). Merged with auto-generated HTTP initiator. */
  readonly initiators?: readonly InitiatorConfig[];
  /** Consumer theme overrides for binding-driven SSR pages (ADR-124-12c). */
  readonly theme?: import('./ssr-renderer').ThemeConfig;
  /** Consumer layout shell overrides for binding-driven SSR pages (ADR-124-12c). */
  readonly layout?: import('./ssr-renderer').LayoutConfig;
  /** I18n instance — when set, mounts middleware and threads lang into SSR. */
  readonly i18n?: import('@janus/i18n').I18nInstance;
}

export interface App {
  readonly registry: CompileResult;
  readonly store: EntityStore;
  readonly runtime: DispatchRuntime;
  readonly broker: Broker;
  readonly connectionManager: ConnectionManager;
  dispatch(
    entity: string,
    operation: string,
    input: unknown,
    identity?: Identity,
  ): Promise<DispatchResponse>;
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

  // New API: http + apiKeys → create surface internally
  if (config.http) {
    const basePath = config.http.basePath ?? '/api';
    const participations: ParticipationRecord[] = [
      {
        source: 'api-surface',
        handler: 'http-receive',
        order: 5,
        transactional: false,
        config: { basePath },
      },
      {
        source: 'api-surface',
        handler: 'http-identity',
        order: 6,
        transactional: false,
        config: config.apiKeys ? { keys: config.apiKeys } : {},
      },
      {
        source: 'api-surface',
        handler: 'identity-provision',
        order: 7,
        transactional: false,
        config: {},
      },
      {
        source: 'api-surface',
        handler: 'http-respond',
        order: 80,
        transactional: false,
        config: {},
      },
    ];
    const initiator: InitiatorConfig = { name: 'api-surface', origin: 'consumer', participations };
    initiators.push(initiator);
    surfaceConfigs.push({ initiator, basePath });
  }

  // Custom initiators (e.g., agent surfaces)
  if (config.initiators) {
    for (const init of config.initiators) {
      initiators.push(init);
    }
  }

  // Deprecated API: surfaces (backward compat)
  if (config.surfaces) {
    for (const s of config.surfaces) {
      initiators.push(s.initiator);
      surfaceConfigs.push(s);
    }
  }

  const registry = compile(
    [...config.declarations, ...frameworkEntities, ...frameworkParticipations],
    initiators,
  );

  // Phase 2: Store initialization
  // When an i18n instance is provided (ADR 125-00), auto-forward its langs +
  // defaultLang to both adapters so `Translatable(...)` fields provision the
  // matching parallel columns. Apps that want strict-mode (no fallback) or
  // a different lang set still create the adapters manually.
  const translatable = config.i18n
    ? { langs: config.i18n.langs, defaultLang: config.i18n.defaultLang }
    : undefined;
  const sqliteAdapter = createSqliteAdapter({
    path: config.store?.path ?? ':memory:',
    translatable,
  });
  const memoryAdapter = createMemoryAdapter({ translatable });

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
  const runtime = createDispatchRuntime({
    registry,
    store,
    broker,
    assetBackend: config.assetBackend,
  });

  // Phase 4: Subscription processor
  const subscriptionHandle = startSubscriptionProcessor({ runtime, broker, store, registry });

  // Phase 5: Broker → SSE bridge
  const enableSse = config.enableSse ?? surfaceConfigs.length > 0;
  let sseBridgeUnsub: (() => void) | undefined;
  if (enableSse) {
    sseBridgeUnsub = startBrokerSseBridge({ broker, connectionManager, store });
  }

  // Phase 5.5: Auth routes — read oidc_provider and create auth routes if configured
  let authRoutes: Hono | undefined;
  if (surfaceConfigs.length > 0) {
    try {
      const oidcRecord = await store.read('oidc_provider', { id: '_s:oidc_provider' });
      if (oidcRecord && 'id' in oidcRecord) {
        const oidcProvider = oidcRecord as unknown as OidcProviderRecord;
        if (oidcProvider.issuer && oidcProvider.client_id) {
          const basePath = surfaceConfigs[0].basePath;
          authRoutes = createAuthRoutes({ oidcProvider, runtime, basePath });
        }
      }
    } catch {
      // oidc_provider entity not available — auth routes not mounted
    }
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
      authRoutes,
      theme: config.theme,
      layout: config.layout,
      i18n: config.i18n,
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
