/**
 * Demo app subscriptions — reactive wiring for demo entities.
 */

import { subscribe, Updated } from '@janus/core';
import { task } from './entities';

/**
 * Track task updates in the execution_log via the tracked subscription path.
 * The dispatch-adapter fires and the tracked machinery writes status rows.
 */
export const taskSubscription = subscribe(task, [
  {
    on: Updated,
    handler: 'dispatch-adapter',
    config: { entity: 'task', operation: 'read' },
    failure: 'log',
    tracked: true,
  },
  // Nightly stale task check — reads tasks to surface stuck work.
  {
    cron: '0 0 * * *',
    handler: 'dispatch-adapter',
    config: { entity: 'task', operation: 'read' },
    failure: 'retry',
    tracked: true,
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 },
  },
]);

export const allSubscriptions = [taskSubscription];
