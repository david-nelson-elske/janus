/**
 * subscribe() — Event and schedule wiring.
 *
 * Produces SubscriptionRecords from SubscriptionInput[].
 * Event subscriptions fire when a matching broker notification arrives.
 * Cron subscriptions fire on schedule via the scheduler.
 *
 * STABLE — subscribe() is the consumer API for reactive wiring (ADR 07).
 */

import type {
  DefineResult,
  SubscribeResult,
  SubscriptionInput,
  SubscriptionRecord,
} from './types';
import { resolveEntityName } from './types';

function isEventInput(input: SubscriptionInput): input is SubscriptionInput & { on: unknown } {
  return 'on' in input;
}

export function subscribe(
  entity: string | DefineResult,
  subscriptions: readonly SubscriptionInput[],
): SubscribeResult {
  const entityName = resolveEntityName(entity);

  const records: SubscriptionRecord[] = subscriptions.map((sub) => {
    if (isEventInput(sub)) {
      return Object.freeze({
        source: entityName,
        trigger: Object.freeze({ kind: 'event' as const, on: sub.on }),
        handler: sub.handler,
        config: Object.freeze({ ...sub.config }),
        failure: sub.failure ?? 'log',
        tracked: sub.tracked,
        retry: sub.retry,
      });
    }
    // Cron input
    return Object.freeze({
      source: entityName,
      trigger: Object.freeze({ kind: 'cron' as const, expr: sub.cron }),
      handler: sub.handler,
      config: Object.freeze({ ...sub.config }),
      failure: sub.failure ?? 'retry',
      tracked: sub.tracked,
      retry: sub.retry,
    });
  });

  return Object.freeze({
    kind: 'subscribe' as const,
    records: Object.freeze(records),
  });
}
