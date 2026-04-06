/**
 * Scheduler — fires cron-triggered subscriptions on schedule.
 *
 * For each cron subscription, calculates the next match time and
 * uses setTimeout to schedule execution. After each fire, schedules
 * the next occurrence.
 *
 * STABLE — ADR 07. Cron subscriptions.
 */

import type { CompileResult, SubscriptionRecord } from '@janus/core';
import type { EntityStore } from '@janus/core';
import type { DispatchRuntime } from './dispatch';
import { executeSubscription } from './subscription-processor';
import { parseCron, nextCronMatch } from './cron';

export interface SchedulerConfig {
  readonly runtime: DispatchRuntime;
  readonly store: EntityStore;
  readonly registry: CompileResult;
}

export interface SchedulerHandle {
  /** Stop all scheduled timers. */
  stop: () => void;
  /** Wait for all in-flight handler executions to complete. For testing. */
  drain: () => Promise<void>;
}

/**
 * Start the scheduler. Parses cron expressions from subscriptions,
 * schedules timeouts, and fires handlers at the right time.
 *
 * Returns a handle with stop() and drain().
 */
export function startScheduler(config: SchedulerConfig): SchedulerHandle {
  const { registry } = config;

  // Filter to cron-triggered subscriptions
  const cronSubs = registry.subscriptions.filter(
    (s): s is SubscriptionRecord & { trigger: { kind: 'cron'; expr: string } } =>
      s.trigger.kind === 'cron',
  );

  const timers = new Map<SubscriptionRecord, ReturnType<typeof setTimeout>>();
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  function scheduleNext(sub: SubscriptionRecord & { trigger: { kind: 'cron'; expr: string } }) {
    if (stopped) return;

    try {
      const fields = parseCron(sub.trigger.expr);
      const next = nextCronMatch(fields, new Date());
      const delay = Math.max(0, next.getTime() - Date.now());

      const timer = setTimeout(() => {
        if (stopped) return;
        timers.delete(sub);

        const correlationId = `cron-${sub.source}-${Date.now()}`;
        const p = executeSubscription(
          sub,
          { _trigger: { kind: 'cron', expr: sub.trigger.expr } },
          correlationId,
          config,
        );

        inflight.add(p);
        p.finally(() => {
          inflight.delete(p);
          scheduleNext(sub);
        });
      }, delay);

      timers.set(sub, timer);
    } catch (err) {
      console.error(`[scheduler] Failed to parse cron '${sub.trigger.expr}' for ${sub.source}:`, err);
    }
  }

  for (const sub of cronSubs) {
    scheduleNext(sub);
  }

  return {
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    async drain() {
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },
  };
}
