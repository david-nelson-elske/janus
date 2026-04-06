/**
 * createTestHarness() — one-liner test setup for next-next.
 *
 * Handles: registerHandlers, define, participate, compile, createMemoryAdapter,
 * createEntityStore, initialize, createBroker, createDispatchRuntime.
 *
 * Returns dispatch(), store, broker, registry, and event capture helpers.
 */

import type {
  CompileResult,
  DeclarationRecord,
  DispatchResponse,
  EntityStore,
  Identity,
  InitiatorConfig,
  ReadPage,
} from '@janus/core';
import { clearRegistry, compile, SYSTEM } from '@janus/core';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
  startSubscriptionProcessor,
} from '@janus/pipeline';
import type { Broker, BrokerNotification, DispatchRuntime } from '@janus/pipeline';
import { createMemoryAdapter, createDerivedAdapter, createEntityStore } from '@janus/store';

// ── Types ───────────────────────────────────────────────────────

export interface TestHarness {
  /** The compiled registry. */
  readonly registry: CompileResult;

  /** The entity store (direct access for assertions). */
  readonly store: EntityStore;

  /** The broker (direct access for event assertions). */
  readonly broker: Broker;

  /** The dispatch runtime (direct access for custom initiator dispatch). */
  readonly runtime: DispatchRuntime;

  /** All broker notifications since creation (or last resetEvents()). */
  readonly events: BrokerNotification[];

  /** Dispatch through the full pipeline. Defaults to system initiator + SYSTEM identity. */
  dispatch(
    entity: string,
    operation: string,
    input?: unknown,
    identity?: Identity,
  ): Promise<DispatchResponse>;

  /** Reset the captured events list. */
  resetEvents(): void;

  /** Teardown: stop subscription processor, clear registry. */
  teardown(): void;
}

export interface TestHarnessConfig {
  /** Declaration records: results of define(), participate(), subscribe(), bind(). */
  readonly declarations: readonly DeclarationRecord[];

  /** Initiator configs (e.g., from apiSurface() or agentSurface()). Default: none. */
  readonly initiators?: readonly InitiatorConfig[];

  /** Include framework entities (execution_log, template, etc.). Default: true. */
  readonly includeFramework?: boolean;

  /** Default identity for dispatch calls. Default: SYSTEM. */
  readonly defaultIdentity?: Identity;

  /** Max re-entrancy depth. Default: 5. */
  readonly maxDepth?: number;

  /** Enable subscription processor (event-triggered reactions). Default: false. */
  readonly enableSubscriptions?: boolean;

  /** Default initiator for dispatch(). Default: 'system'. */
  readonly defaultInitiator?: string;
}

// ── Factory ─────────────────────────────────────────────────────

export async function createTestHarness(config: TestHarnessConfig): Promise<TestHarness> {
  clearRegistry();
  registerHandlers();

  const includeFramework = config.includeFramework ?? true;

  const allDeclarations = [
    ...config.declarations,
    ...(includeFramework ? frameworkEntities : []),
    ...(includeFramework ? frameworkParticipations : []),
  ];

  const registry = compile(allDeclarations, config.initiators);

  const memAdapter = createMemoryAdapter();
  let storeRef: import('@janus/core').EntityStore;
  const derivedAdapter = createDerivedAdapter({ getStore: () => storeRef });

  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memAdapter, memory: memAdapter, derived: derivedAdapter },
  });
  storeRef = store;
  await store.initialize();

  const broker = createBroker();
  const events: BrokerNotification[] = [];
  broker.onNotify((event) => events.push(event));

  const defaultIdentity = config.defaultIdentity ?? SYSTEM;
  const defaultInitiator = config.defaultInitiator ?? 'system';

  const runtime = createDispatchRuntime({
    registry,
    store,
    broker,
    maxDepth: config.maxDepth,
    defaultIdentity,
  });

  let subscriptionHandle: { unsubscribe(): void } | undefined;
  if (config.enableSubscriptions) {
    subscriptionHandle = startSubscriptionProcessor({ runtime, broker, store, registry });
  }

  return {
    registry,
    store,
    broker,
    runtime,
    events,

    dispatch(entity, operation, input, identity) {
      return runtime.dispatch(
        defaultInitiator,
        entity,
        operation,
        input ?? {},
        identity ?? defaultIdentity,
      );
    },

    resetEvents() {
      events.length = 0;
    },

    teardown() {
      if (subscriptionHandle) subscriptionHandle.unsubscribe();
      clearRegistry();
    },
  };
}
