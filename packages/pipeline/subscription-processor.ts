/**
 * Subscription processor — listens to broker notifications and fires
 * matching event-triggered subscriptions.
 *
 * Also exports executeSubscription() — shared by the scheduler for cron subs.
 *
 * STABLE — ADR 07 + 07b.
 */

import type { CompileResult, Identity, RetryConfig, SubscriptionRecord } from '@janus/core';
import { SYSTEM, resolveHandler, createHandlerContext } from '@janus/core';
import type { Broker, BrokerNotification, Unsubscribe } from './broker';
import type { DispatchRuntime } from './dispatch';
import type { EntityStore } from '@janus/core';
import { buildContext } from './context';

export interface SubscriptionProcessorConfig {
  readonly runtime: DispatchRuntime;
  readonly broker: Broker;
  readonly store: EntityStore;
  readonly registry: CompileResult;
}

export interface SubscriptionProcessorHandle {
  /** Remove all broker listeners. */
  unsubscribe: () => void;
  /** Wait for all in-flight handler executions to complete. For testing. */
  drain: () => Promise<void>;
}

/**
 * Start the subscription processor. Listens to broker notifications,
 * matches against event-triggered subscriptions, and fires handlers.
 *
 * Returns a handle with unsubscribe() and drain() (for deterministic testing).
 */
export function startSubscriptionProcessor(config: SubscriptionProcessorConfig): SubscriptionProcessorHandle {
  const { runtime, broker, store, registry } = config;
  const subscriptions = registry.subscriptions;

  // Track in-flight handler promises for drain()
  const inflight = new Set<Promise<void>>();

  // Filter to event-triggered subscriptions only
  const eventSubs = subscriptions.filter(
    (s): s is SubscriptionRecord & { trigger: { kind: 'event' } } =>
      s.trigger.kind === 'event',
  );

  if (eventSubs.length === 0) {
    return { unsubscribe: () => {}, drain: async () => {} };
  }

  // Build lookup: "entity:descriptor" → matching subscriptions
  const matchIndex = new Map<string, SubscriptionRecord[]>();
  for (const sub of eventSubs) {
    const descriptor = sub.trigger.on.kind;
    const key = `${sub.source}:${descriptor}`;
    let matches = matchIndex.get(key);
    if (!matches) {
      matches = [];
      matchIndex.set(key, matches);
    }
    matches.push(sub);
  }

  // Listen to all broker notifications
  const unsubscribe = broker.onNotify((notification: BrokerNotification) => {
    const key = `${notification.entity}:${notification.descriptor}`;
    const matches = matchIndex.get(key);
    if (!matches || matches.length === 0) return;

    for (const subscription of matches) {
      const p = executeSubscription(subscription, {
        entity: notification.entity,
        entityId: notification.entityId,
        descriptor: notification.descriptor,
      }, notification.correlationId, { runtime, store, registry });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
  });

  return {
    unsubscribe,
    async drain() {
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },
  };
}

// ── Shared subscription execution ────────────────────────────────

export interface ExecutionConfig {
  readonly runtime: DispatchRuntime;
  readonly store: EntityStore;
  readonly registry: CompileResult;
}

/**
 * Execute a subscription handler with retry, tracking, and dead-letter support.
 * Used by both the event subscription processor and the cron scheduler.
 */
export async function executeSubscription(
  subscription: SubscriptionRecord,
  input: Record<string, unknown>,
  correlationId: string,
  config: ExecutionConfig,
): Promise<void> {
  const { runtime, store, registry } = config;
  const handlerEntry = resolveHandler(subscription.handler);

  if (!handlerEntry) {
    console.error(`[subscription-processor] Unresolved handler: '${subscription.handler}'`);
    return;
  }

  const maxAttempts = resolveMaxAttempts(subscription);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Write tracked running status
      if (subscription.tracked) {
        await writeTrackedLog(store, subscription, 'running', attempt, correlationId);
      }

      const ctx = buildContext({
        correlationId,
        traceId: correlationId,
        identity: SYSTEM,
        entity: subscription.source,
        operation: 'create',
        input,
        depth: 0,
        store,
        registry,
        _dispatch: (entity: string, op: string, inp: unknown, identity: Identity) =>
          runtime.dispatch('system', entity, op, inp, identity),
      });

      // Use shared createHandlerContext (same pattern as compile.ts assembleStages)
      const { ctx: handlerCtx } = createHandlerContext(ctx, subscription.config);
      await handlerEntry.fn(handlerCtx);

      // Write tracked success record
      if (subscription.tracked) {
        await writeTrackedLog(store, subscription, 'completed', attempt, correlationId);
      }
      return;
    } catch (err) {
      lastError = err;

      if (subscription.tracked) {
        const status = attempt < maxAttempts ? 'failed' : 'dead';
        const retention = status === 'dead' ? 'forever' : retentionForHandler(subscription.handler);
        await writeTrackedLog(store, subscription, status, attempt, correlationId, err, retention);
      }

      if (attempt < maxAttempts) {
        const delay = calculateBackoff(subscription.retry, attempt);
        await sleep(delay);
      }
    }
  }

  // Log on exhaustion for all untracked failures
  if (!subscription.tracked) {
    console.error(
      `[subscription-processor] Handler '${subscription.handler}' failed for ${subscription.source} after ${maxAttempts} attempt(s):`,
      lastError,
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveMaxAttempts(subscription: SubscriptionRecord): number {
  if (subscription.retry) return subscription.retry.max;
  return subscription.failure === 'retry' ? 3 : 1;
}

/** Per-adapter retention defaults (ADR 07b). */
const RETENTION_DEFAULTS: Record<string, string> = {
  'dispatch-adapter': '90d',
  'connector-distribute': '90d',
  'webhook-sender': '30d',
  'notify-sender': '30d',
};

function retentionForHandler(handler: string): string {
  return RETENTION_DEFAULTS[handler] ?? '90d';
}

/**
 * Calculate backoff delay for a retry attempt.
 * Uses RetryConfig when available, otherwise hardcoded defaults.
 */
export function calculateBackoff(retry: RetryConfig | undefined, attempt: number): number {
  if (retry) {
    if (retry.backoff === 'fixed') return retry.initialDelay;
    // exponential: initialDelay * 2^(attempt-1)
    return retry.initialDelay * Math.pow(2, attempt - 1);
  }
  // Fallback: 100ms * 5^(attempt-1) (scaled down for in-process)
  return 100 * Math.pow(5, attempt - 1);
}

async function writeTrackedLog(
  store: EntityStore,
  subscription: SubscriptionRecord,
  status: string,
  attempt: number,
  correlationId: string,
  error?: unknown,
  retention?: string,
): Promise<void> {
  try {
    await store.create('execution_log', {
      handler: subscription.handler,
      source: subscription.source,
      status,
      timestamp: new Date().toISOString(),
      duration: 0,
      attempt,
      retention: retention ?? retentionForHandler(subscription.handler),
      payload: {
        correlationId,
        trigger: subscription.trigger,
        attempt,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      },
      createdBy: 'system',
      updatedBy: 'system',
    });
  } catch (logErr) {
    console.error('[subscription-processor] Failed to write execution_log:', logErr);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
