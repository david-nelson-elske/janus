# 124-07b: Tracked Subscriptions & Dead-Letter

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [02](02-wiring-functions.md) (Wiring Functions), [04b](04b-append-storage-and-execution-log.md) (Execution Log), [07](07-subscriptions-broker-scheduler.md) (Subscriptions)

## Scope

This sub-ADR specifies:
- `tracked` flag on subscription records — automatic run tracking for async work
- Retry policy: `retry` config with max attempts and backoff
- How tracked subscription status progression is recorded as rows in `execution_log` ([04b](04b-append-storage-and-execution-log.md))
- Dead-letter as a status value ('dead') on execution_log rows
- How connectors and background jobs compose from tracked subscriptions + entity patterns

This sub-ADR does NOT cover:
- `execution_log` entity, `Append()` column type, retention cleanup ([04b](04b-append-storage-and-execution-log.md))
- Connector-specific entities and patterns ([07c](07c-connectors.md))
- Untracked subscription adapters ([07](07-subscriptions-broker-scheduler.md))
- Pipeline concern adapters ([05](05-pipeline-concern-adapters.md))

## Problem

ADR-124's subscription model ([07](07-subscriptions-broker-scheduler.md)) handles event-driven and scheduled work with two failure policies: `log` (capture error, continue) and `retry` (3 attempts with backoff). But:

1. **No execution tracking.** There's no record that a subscription fired, how long it took, or what it produced. "Did the nightly cleanup run?" has no answer.
2. **No dead letter.** After retry exhaustion, the failed work disappears. Production systems need a place to inspect and re-drive failed work.
3. **Connectors and jobs duplicate infrastructure.** V1 had separate `_connector_run`, `_job`, and `_dead_letter` entities with largely identical tracking patterns (status lifecycle, timing, stats, retry).

These are all instances of the same need: **tracked asynchronous work with failure handling**.

## Decision

### Tracked subscriptions

The subscription record gains optional tracking and retry configuration:

```ts
interface SubscriptionRecord {
  // ... existing fields from 07 ...
  readonly tracked?: boolean;
  readonly retry?: RetryConfig;
}

interface RetryConfig {
  readonly max: number;           // max attempts (default: 3)
  readonly backoff: 'fixed' | 'exponential';
  readonly initialDelay: number;  // milliseconds (default: 1000)
}
```

When `tracked: true`, the subscription processor wraps the execution adapter with automatic run tracking — writing status rows to `execution_log` ([04b](04b-append-storage-and-execution-log.md)).

When `tracked` is omitted or false, behavior is unchanged from [07](07-subscriptions-broker-scheduler.md) — fire-and-forget with `log` or basic `retry`.

### Consumer DX

```ts
// Untracked — fire and forget (existing behavior)
subscribe('note', [
  { on: Created, handler: 'webhook-sender', config: { url: '...' } },
]);

// Tracked — execution_log rows + retry + dead-letter
subscribe('note', [
  { on: Created, handler: 'webhook-sender', config: { url: '...' },
    tracked: true,
    retry: { max: 5, backoff: 'exponential', initialDelay: 1000 } },
]);

// Tracked scheduled action (connector pattern)
subscribe('connector_mailchimp', [
  { cron: '0 */6 * * *', handler: 'dispatch-adapter',
    config: { entity: 'connector_mailchimp', action: 'sync' },
    tracked: true,
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 } },
]);

// Tracked event-driven action (job pattern)
subscribe('email_send_job', [
  { on: Created, handler: 'dispatch-adapter',
    config: { entity: 'email_send_job', action: 'execute' },
    tracked: true,
    retry: { max: 3, backoff: 'exponential', initialDelay: 1000 } },
]);
```

### Status rows in execution_log

Tracked subscriptions write multiple rows to `execution_log` — one per status event. The table is Persistent ([04b](04b-append-storage-and-execution-log.md)). Each row carries its own `retention` value. Heavy payloads (error details, trigger context, adapter stats) live in append files, referenced by the row's `payload` pointer — the same pattern as `asset.path` in [08b](08b-assets-and-media.md).

**Status progression:**

| Event | status | retention | Payload (in append file) |
|-------|--------|-----------|--------------------------|
| Execution starts | `running` | per-execution default | trigger context, input |
| Success | `completed` | per-execution default | adapter stats, duration |
| Failure (retries remain) | `failed` | per-execution default | error message |
| Retry starts | `running` | per-execution default | trigger context, new attempt |
| Final failure (retries exhausted) | `dead` | `forever` | error message, all attempts summary |
| Manual resolve | `resolved` | `90d` | resolution notes |
| Intentional drop | `abandoned` | `90d` | reason |

Each is a new row — no updates. Rows for the same subscription execution share `handler` + `source` and are linked by `attempt` number.

**Per-execution retention defaults:**

| Execution | Default retention |
|-----------|------------------|
| `dispatch-adapter` | `90d` |
| `connector-distribute` | `90d` |
| `webhook-sender` | `30d` |
| `notify-sender` | `30d` |

The subscription processor sets the `retention` value when writing each row. Consumers can override via subscription config. Dead rows always get `forever` retention regardless of defaults.

### Dead-letter as status

Dead-lettered work is an `execution_log` row with `status: 'dead'` and `retention: 'forever'`. No separate entity. No lifecycle entity. Just rows in the log.

The agent manages dead letters:

```ts
// Find all dead-lettered work
read('execution_log', { where: { status: 'dead' } })

// Find dead letters for a specific connector
read('execution_log', { where: { status: 'dead', source: 'connector_mailchimp' } })
```

**Resolution is new rows, not updates:**

- **Retry:** The subscription processor creates a new `running` row. The `dead` row stays as history.
- **Resolve:** Write a new row with `status: 'resolved'` — same handler + source.
- **Abandon:** Write a new row with `status: 'abandoned'`.

"Retry all failed Mailchimp syncs" → agent reads dead rows, triggers re-execution for each, which creates new `running` rows.

### Subscription processor enrichment

The subscription processor from [07](07-subscriptions-broker-scheduler.md) is enriched to handle tracking:

```
processSubscription(subscription, trigger):
  if not subscription.tracked:
    // Existing behavior: fire adapter, log or basic retry
    return existingBehavior(subscription, trigger)

  // Tracked path — write status rows to execution_log
  retention = subscription.retention ?? retentionDefault(subscription.handler)

  await dispatch('execution_log', 'create', {
    handler: subscription.handler,
    source: subscription.source,
    status: 'running',
    timestamp: now(),
    attempt: 1,
    retention: retention,
    payload: { trigger: trigger, input: trigger.context },
  }, SYSTEM)

  try:
    result = await executeAdapter(subscription, trigger)
    await dispatch('execution_log', 'create', {
      handler: subscription.handler,
      source: subscription.source,
      status: 'completed',
      timestamp: now(),
      duration: elapsed(),
      attempt: 1,
      retention: retention,
      payload: { stats: result.stats },
    }, SYSTEM)

  catch error:
    if attempt < subscription.retry.max:
      await dispatch('execution_log', 'create', {
        handler: subscription.handler,
        source: subscription.source,
        status: 'failed',
        timestamp: now(),
        attempt: attempt,
        retention: retention,
        payload: { error: error.message },
      }, SYSTEM)
      scheduleRetry(subscription, trigger, attempt + 1, calculateDelay(subscription.retry, attempt))

    else:
      await dispatch('execution_log', 'create', {
        handler: subscription.handler,
        source: subscription.source,
        status: 'dead',
        timestamp: now(),
        attempt: attempt,
        retention: 'forever',
        payload: { error: error.message, attempts: attempt, history: attemptSummary },
      }, SYSTEM)
```

### Backoff calculation

```
calculateDelay(retry, attempt):
  if retry.backoff === 'fixed':
    return retry.initialDelay
  if retry.backoff === 'exponential':
    return retry.initialDelay * (2 ** (attempt - 1))
    // attempt 1: 1s, attempt 2: 2s, attempt 3: 4s, attempt 4: 8s, ...
```

### How connectors and jobs compose

**Connector** = entity + tracked scheduled subscription + connector-specific binding entity:
- Define the connector entity (config, status)
- Declare a `sync` action via `actions()`
- Schedule with tracked subscription via `subscribe()`
- Track external ID mapping in `connector_binding` (see [07c](07c-connectors.md))
- Run history visible in `execution_log`, dead-lettered work queryable by `status: 'dead'`

**Job** = entity with claim lifecycle + tracked event subscription:
- Define the job entity with lifecycle (queued → claimed → completed → failed)
- Declare `execute` action via `actions()`
- Trigger with tracked subscription (on Created → dispatch execute action)
- Claim semantics via lifecycle transition (queued → claimed is a regular update)
- Singular claim via optimistic concurrency (`version` from [01b](01b-record-metadata-ownership-scoping.md))
- Run history visible in `execution_log`, dead-lettered work queryable by `status: 'dead'`

Both patterns use the same infrastructure: tracked subscriptions + `execution_log` rows. No separate job engine or connector engine. The entity graph provides the domain-specific state; the tracking infrastructure is shared.

## Testing gate

When 124-07b is implemented:

- `subscribe('note', [{ on: Created, handler: 'webhook-sender', tracked: true, ... }])` produces subscription record with `tracked: true`
- Tracked subscription writes `execution_log` row with `status: 'running'` on execution start
- Successful tracked execution writes `status: 'completed'` row with duration
- Failed tracked execution with retries remaining writes `status: 'failed'` row and schedules retry
- Failed tracked execution after retry exhaustion writes `status: 'dead'` row with `retention: 'forever'`
- Dead rows share `handler` + `source` with preceding running/failed rows
- Manual retry creates new `running` row (dead row stays as history)
- Manual resolve writes `status: 'resolved'` row
- Manual abandon writes `status: 'abandoned'` row
- Each `execution_log` row carries its own `retention` value
- Exponential backoff calculates correct delays
- Untracked subscriptions behave unchanged (no execution_log rows)
- `read('execution_log', { where: { source: 'connector_mailchimp', status: 'completed' } })` returns run history
- `read('execution_log', { where: { status: 'dead' } })` returns dead-lettered work
