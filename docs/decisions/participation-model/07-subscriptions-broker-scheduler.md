# 124-07: Subscriptions, Broker, and Scheduler

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md), [02](02-wiring-functions.md), [05](05-pipeline-concern-adapters.md), [06](06-dispatch-runtime.md)

## Scope

This sub-ADR specifies:
- `SubscriptionRecord` type — the event/schedule wiring junction
- `subscribe()` — produces subscription records
- Broker interface and implementation (carried forward, in-process notification)
- Event trigger subscriptions (entity event → handler)
- Cron trigger subscriptions (schedule expression → handler)
- Subscription handler adapters: dispatch-adapter, webhook-sender, stream-pusher, notify-sender
- Failure policies: log, retry
- How tracked subscription adapters write to `execution_log` ([04b](04b-append-storage-and-execution-log.md), [07b](07b-tracked-subscriptions-dead-letter.md))
- `startSubscriptionProcessor()` and `startScheduler()`

This sub-ADR does NOT cover:
- Pipeline concern adapters ([05](05-pipeline-concern-adapters.md))
- Presentation/binding ([10](10-presentation-and-binding.md))
- HTTP surface ([08](08-http-surface-and-bootstrap.md))
- Agent surface ([09](09-agent-surface-and-session.md))

## SubscriptionRecord

The junction connecting a graph-node to a trigger and a handler:

```ts
interface SubscriptionRecord {
  readonly source: string;              // Reference → GraphNodeRecord.name
  readonly trigger: EventTrigger | CronTrigger;
  readonly handler: string;             // Handler() key → runtime function registry
  readonly config: Readonly<Record<string, unknown>>;
  readonly failure: FailurePolicy;
}

interface EventTrigger {
  readonly kind: 'event';
  readonly on: EventDescriptor;
}

interface CronTrigger {
  readonly kind: 'cron';
  readonly expr: string;  // five-field cron expression (minute hour dom month dow)
}

type FailurePolicy = 'log' | 'retry';
```

| Field | Description |
|-------|-------------|
| `source` | The entity this subscription is for. |
| `trigger` | When to fire: on entity event or on cron schedule. |
| `handler` | What to run: Handler() key referencing a function in the runtime registry (dispatch-adapter, webhook-sender, etc.). |
| `config` | Adapter-specific config (dispatch target, webhook URL, etc.). |
| `failure` | What to do on failure: `'log'` (capture and continue) or `'retry'` (retry with backoff). |

## subscribe()

```ts
function subscribe(
  entity: string | DefineResult,
  subscriptions: readonly SubscriptionInput[],
): SubscribeResult

interface SubscribeResult {
  readonly kind: 'subscribe';
  readonly records: readonly SubscriptionRecord[];
}
```

### SubscriptionInput

```ts
type SubscriptionInput = EventSubscriptionInput | CronSubscriptionInput;

interface EventSubscriptionInput {
  readonly on: EventDescriptor;
  readonly handler: string;
  readonly config: Record<string, unknown>;
  readonly failure?: FailurePolicy; // default: 'log'
}

interface CronSubscriptionInput {
  readonly cron: string;
  readonly handler: string;
  readonly config: Record<string, unknown>;
  readonly failure?: FailurePolicy; // default: 'retry'
}
```

### Example

```ts
subscribe('note', [
  // Reaction: on note created, dispatch to feed:notify
  { on: Created, handler: 'dispatch-adapter', config: { entity: 'feed', action: 'notify' }, failure: 'log' },

  // Webhook: on note created, POST to external URL
  { on: Created, handler: 'webhook-sender', config: { url: 'https://hooks.example.com/notes', method: 'POST' }, failure: 'retry' },

  // Scheduled cleanup: purge old drafts daily at midnight
  { cron: '0 0 * * *', handler: 'dispatch-adapter', config: { entity: 'note', action: 'purge-drafts' }, failure: 'log' },
]);
```

## Broker

The broker is the in-process notification layer. The emit concern adapter ([05](05-pipeline-concern-adapters.md)) calls `broker.notify()` after writing to `emit:records`. The subscription processor listens for notifications and fires matching subscriptions.

```ts
interface Broker {
  notify(notification: BrokerNotification): void;
  onNotify(listener: NotifyListener): Unsubscribe;
  onNotify(filter: NotifyFilter, listener: NotifyListener): Unsubscribe;
}

interface BrokerNotification {
  readonly entity: string;
  readonly entityId?: string;
  readonly descriptor: string;     // event descriptor kind
  readonly correlationId: string;
}

type NotifyListener = (notification: BrokerNotification) => void;

interface NotifyFilter {
  readonly entity?: string;
  readonly descriptor?: string;
}

type Unsubscribe = () => void;
```

`createBroker()` is carried forward from packages/next. It is synchronous — `notify()` pushes to a listener queue, listeners execute asynchronously.

## Subscription processor

Processes event-triggered subscriptions:

```ts
function startSubscriptionProcessor(config: {
  runtime: DispatchRuntime;
  broker: Broker;
  store: EntityStore;
  subscriptions: readonly SubscriptionRecord[];
}): Unsubscribe
```

**Behavior:**
1. Filter subscriptions to `trigger.kind === 'event'`.
2. Group by `(source, trigger.on.kind)`.
3. Register a broker listener for each group.
4. When a notification arrives:
   a. Find matching subscriptions by entity name + event descriptor.
   b. For each match, resolve the Handler() key and call the function with the notification context.
   c. Apply failure policy: `'log'` captures errors; `'retry'` retries with exponential backoff (max 3 attempts).

Returns an `Unsubscribe` function that removes all broker listeners.

## Scheduler

Processes cron-triggered subscriptions:

```ts
function startScheduler(config: {
  runtime: DispatchRuntime;
  store: EntityStore;
  subscriptions: readonly SubscriptionRecord[];
}): Unsubscribe
```

**Behavior:**
1. Filter subscriptions to `trigger.kind === 'cron'`.
2. For each cron subscription, schedule execution using the cron expression.
3. On trigger: resolve the Handler() key and call the function.
4. Apply failure policy.

Returns an `Unsubscribe` function that stops all scheduled timers.

The scheduler implementation should use a lightweight cron evaluator (e.g., `cron-parser` or equivalent). It does NOT use system-level cron — it runs in-process timers.

## Subscription handler adapters

Four framework-seeded handlers for subscription handling:

### dispatch-adapter

Dispatches to another entity operation. The most common subscription adapter — enables reactions.

```ts
const dispatchAdapter: ExecutionHandler = async (ctx) => {
  const config = ctx.config as { entity: string; action?: string; operation?: Operation };
  const operation = config.action ?? config.operation ?? 'create';
  const input = { ...ctx.event }; // pass the triggering event as input
  await ctx._dispatch(config.entity, operation, input, SYSTEM);
};
```

Registered as `handler('dispatch-adapter', dispatchAdapter, 'Dispatch to entity:operation')`.

### webhook-sender

POST payload to an external URL.

```ts
const webhookSender: ExecutionHandler = async (ctx) => {
  const config = ctx.config as { url: string; method?: string; headers?: Record<string, string> };
  const response = await fetch(config.url, {
    method: config.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...config.headers },
    body: JSON.stringify(ctx.event),
  });
  // Tracked subscriptions write delivery records to execution_log (see 07b)
  // Untracked subscriptions are fire-and-forget
};
```

### stream-pusher

Push event to an SSE/WebSocket stream. See [12a](12a-connection-protocol-and-sync.md) for connection protocol details.

```ts
const streamPusher: ExecutionHandler = async (ctx) => {
  const config = ctx.config as { channel: string };
  // Routes entity events to matching connections
  // Stream connections are tracked in the connection entity (12a), not execution_log
};
```

### notify-sender

Send notification via a delivery channel (email, SMS, push).

```ts
const notifySender: ExecutionHandler = async (ctx) => {
  const config = ctx.config as { template: string; via: string; recipient?: string };
  // Tracked subscriptions write delivery records to execution_log (see 07b)
  // Untracked subscriptions are fire-and-forget
};
```

## Subscription output

Tracked subscription adapters write delivery records to `execution_log` ([04b](04b-append-storage-and-execution-log.md)). Each delivery is a row with `handler` set to the adapter name (e.g., `'webhook-sender'`, `'notify-sender'`), filterable by `source` (entity name). Heavy payloads (request/response bodies, error traces) live in the `Append()` payload column. See [07b](07b-tracked-subscriptions-dead-letter.md) for the full tracked subscription lifecycle.

Untracked subscriptions are fire-and-forget — no execution_log rows.

Stream connections are tracked in the `connection` entity ([12a](12a-connection-protocol-and-sync.md)), not execution_log — they have different lifecycle semantics (open/close, not run/complete/fail).

## Failure policies

| Policy | Behavior |
|--------|----------|
| `'log'` | On failure, log the error and continue. No retry. Used for non-critical subscriptions (reactions, observations). |
| `'retry'` | On failure, retry with exponential backoff. Max 3 attempts (delays: 1s, 5s, 25s). After exhaustion, log as dead letter. Used for external integrations (webhooks, notifications). |

Dead letter records are written to the subscription output entity with a failure status.

## Testing gate

When 124-07 is implemented, the following should be testable:

- `subscribe('note', [{ on: Created, ... }])` produces correct `SubscriptionRecord` with event trigger
- `subscribe('note', [{ cron: '0 0 * * *', ... }])` produces correct `SubscriptionRecord` with cron trigger
- Event subscription fires when matching broker notification arrives
- Event subscription does NOT fire for non-matching entity or event type
- Cron subscription fires on schedule (testable with mock timers)
- `dispatch-adapter` subscription dispatches to target entity:operation via system initiator
- `webhook-sender` tracked subscription writes delivery record to `execution_log`
- Failure policy `'log'`: error logged, processing continues
- Failure policy `'retry'`: retries up to 3 times with backoff
- Dead letter written after retry exhaustion
- `startSubscriptionProcessor()` returns unsubscribe that stops all listeners
- `startScheduler()` returns unsubscribe that stops all timers
- Multiple subscriptions for the same entity + event all fire
