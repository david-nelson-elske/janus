# 124-05: Pipeline Concern Adapters

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md), [02](02-wiring-functions.md), [04](04-store-adapters-and-crud.md), [04b](04b-append-storage-and-execution-log.md)

## Scope

This sub-ADR specifies:
- `ConcernContext` — the mutable context passed through pipeline stages
- All framework concern adapter implementations (policy through respond)
- Output entities: `emit_records` (event log), `rate_limit_records` (volatile counters)
- How audit and observe concerns write to `execution_log` ([04b](04b-append-storage-and-execution-log.md))
- `seedHandlers()` — registers framework-seeded handlers in the Handler() backend

This sub-ADR does NOT cover:
- Transport concern adapters ([08](08-http-surface-and-bootstrap.md), [09](09-agent-surface-and-session.md))
- Subscription adapters ([07](07-subscriptions-broker-scheduler.md))
- Presentation adapters ([10](10-presentation-and-binding.md))
- Dispatch runtime orchestration ([06](06-dispatch-runtime.md))
- Store adapter internals ([04](04-store-adapters-and-crud.md))

## ConcernContext

The context object that flows through all pipeline stages. Immutable infrastructure fields are set by the dispatch runtime ([06](06-dispatch-runtime.md)). Mutable fields are accumulated by concern adapters.

```ts
interface ConcernContext {
  // ── Immutable (set by dispatch runtime)
  readonly correlationId: string;
  readonly traceId: string;
  readonly identity: Identity;
  readonly entity: string;
  readonly operation: Operation;
  readonly input: unknown;
  readonly startedAt: number;
  readonly depth: number;
  readonly config: Readonly<Record<string, unknown>>; // from participation record

  // ── Infrastructure (injected by dispatch runtime)
  readonly store: EntityStore;
  readonly broker: Broker;
  readonly registry: CompileResult;
  readonly _dispatch?: InternalDispatch;

  // ── Mutable (accumulated by concern stages)
  parsed?: Record<string, unknown>;
  validated?: boolean;
  before?: EntityRecord | null;
  result?: PersistResult;
  event?: DomainEvent;
  observed?: boolean;
  audited?: boolean;
  error?: DispatchError;
  outboundErrors?: Array<{ stage: string; error: unknown }>;

  // ── Policy output
  policyOwnershipField?: string;
}
```

### Identity (carried forward)

```ts
interface Identity {
  readonly id: string;
  readonly roles: readonly string[];
  readonly scopes?: readonly string[];
}

const ANONYMOUS: Identity = { id: 'anonymous', roles: ['anonymous'] };
const SYSTEM: Identity = { id: 'system', roles: ['system'] };
```

### InternalDispatch

For re-entrant dispatch (handler-to-handler calls):

```ts
type InternalDispatch = (
  entity: string,
  operation: string,
  input: unknown,
  identity: Identity,
) => Promise<DispatchResponse>;
```

This uses the `system` initiator and increments depth.

## Concern adapters

Each adapter is an `ExecutionHandler` registered via `handler()` ([02](02-wiring-functions.md)). The adapter reads its per-entity configuration from `ctx.config` (the participation record's config field, injected per-stage by the dispatch runtime).

### policy-lookup (order=10)

Authorization via hash-map rule lookup. No IO for the common case.

```ts
const policyLookup: ExecutionHandler = async (ctx) => {
  const config = ctx.config as PolicyConfig;
  // ...
};
```

**Behavior:**
1. If `config.anonymousRead` and operation is `read` and identity is ANONYMOUS → allow.
2. Find matching rule: `config.rules.find(r => r.role is in identity.roles AND (r.operations === '*' OR r.operations.includes(operation)))`.
3. If no matching rule → throw `ForbiddenError`.
4. If rule has `ownershipField` → set `ctx.policyOwnershipField` for validate to enforce.

**Config shape:** `PolicyConfig` from [02](02-wiring-functions.md).

### rate-limit-check (order=11)

Counter check against volatile `rate_limit_records`.

**Behavior:**
1. Read config: `{ max, window }` from `ctx.config`.
2. Build counter key: `${ctx.entity}:${ctx.identity.id}`.
3. Read current counter from `rate_limit_records` via store.
4. If counter >= max within window → throw `RateLimitExceededError`.
5. Increment counter.

**Record entity:** `rate_limit_records` (Volatile storage).

```ts
// rate_limit_records schema
{
  key: Str({ required: true }),     // entity:userId
  count: Int({ required: true }),
  windowStart: DateTime({ required: true }),
}
```

### schema-parse (order=20)

Schema-driven input parsing and coercion. Logic carried forward from packages/next's parse step.

**Behavior:**
1. Read entity's schema from `ctx.registry.entity(ctx.entity)`.
2. Validate required fields are present (for create).
3. Coerce field values to match semantic type expectations (string → number, etc.).
4. Strip unknown fields.
5. Set `ctx.parsed = { ...parsedFields }`.

For `read` operations with an `id` parameter, parse extracts the id into `ctx.parsed`.

### schema-validate (order=25)

Schema + lifecycle + ownership validation. Logic carried forward from packages/next's validate step.

**Behavior:**
1. For `update`/`delete`: fetch the before-record via `ctx.store.read(ctx.entity, { id })` and set `ctx.before`.
2. Validate lifecycle transitions: if a lifecycle field is in the patch, check that the transition is legal per the lifecycle's transition map.
3. Validate ownership: if `ctx.policyOwnershipField` is set (from policy), verify the identity owns the record being modified.
4. Stamp lifecycle defaults on create: set initial lifecycle state for each lifecycle field.
5. Set `ctx.validated = true`.

### invariant-check (order=26)

Run predicate functions against the proposed record state.

**Behavior:**
1. Read invariants from `ctx.config` as `readonly InvariantInput[]`.
2. Build proposed state: for create, use `ctx.parsed`; for update, merge `ctx.before` + `ctx.parsed`.
3. Run each predicate. If any fails with `severity: 'error'` → throw `InvariantViolationError`.
4. Collect warnings for `severity: 'warning'` into `ctx.outboundErrors`.

**Config shape:**
```ts
interface InvariantInput {
  readonly name: string;
  readonly predicate: (record: Record<string, unknown>) => boolean;
  readonly severity: 'error' | 'warning';
  readonly message?: string;
}
```

### emit-broker (order=40)

Write event log + broker notification. Transactional for writes.

**Behavior:**
1. Determine event descriptor from operation: create → `Created`, update → `Updated`, delete → `Deleted`.
2. Build `DomainEvent` from context.
3. Write to `emit_records` via store.
4. Set `ctx.event = event`.
5. Notify broker: `ctx.broker.notify({ entity, entityId, descriptor })`.

**Record entity:** `emit_records` (Persistent storage).

```ts
// emit:records schema
{
  source: Str({ required: true }),       // entity name
  entityId: Str(),                       // may be null for bulk
  descriptor: Str({ required: true }),   // event descriptor kind
  record: Json(),                        // the entity record (after)
  before: Json(),                        // the record before mutation
  identity: Json({ required: true }),    // { id, roles }
  cursor: Int({ required: true }),       // monotonic sequence
  correlationId: Str({ required: true }),
  timestamp: DateTime({ required: true }),
}
```

### audit-relational (order=50, transactional=true)

Write audit records for mutations. Uses `execution_log` ([04b](04b-append-storage-and-execution-log.md)).

**Behavior:**
1. Read config: `{ level, on }` — audit level and which events to audit.
2. If current event descriptor is not in `on` list → skip.
3. Build audit record with before/after snapshots.
4. Write to `execution_log` via store: `handler='audit-relational'`, `retention='forever'`, payload contains actor + before/after snapshots.
5. Set `ctx.audited = true`.

**Output:** Row in `execution_log` with `handler='audit-relational'`, `source=ctx.entity`, `status='completed'`, `retention='forever'`. Heavy before/after snapshots live in the `Append()` payload column.

### audit-memory (order=50, transactional=false)

Same as `audit-relational` but writes to `execution_log` with `retention='30d'`. Used for Volatile entities or test environments.

### observe-memory (order=50, transactional=false)

Write observation records. Best-effort — errors are captured, not thrown.

**Behavior:**
1. Read config: `{ on }` — which events to observe.
2. If current event descriptor is not in `on` list → skip.
3. Build observation record with duration, entity, event.
4. Write to `execution_log` via store: `handler='observe-memory'`, `retention='7d'`. On error, push to `ctx.outboundErrors`.
5. Set `ctx.observed = true`.

**Output:** Row in `execution_log` with `handler='observe-memory'`, `source=ctx.entity`, `status='completed'`, `retention='7d'`. Duration and event details in the `Append()` payload column.

### respond-shaper (order=70)

Shape the dispatch result into the response format.

**Behavior:**
1. Read `ctx.result` (set by CRUD handler or action handler).
2. If `ctx.error` is set → response is error shape.
3. Otherwise → response is success shape with data from result.
4. Attach metadata: entity, operation, correlationId, duration.

The respond adapter does NOT produce the final `DispatchResponse` — that is done by the dispatch runtime ([06](06-dispatch-runtime.md)). The respond adapter shapes the ctx.result into a normalized form that the runtime wraps.

## seedHandlers()

Registers all framework-seeded handlers in the Handler() backend:

```ts
function seedHandlers(): void
```

This is called during bootstrap, before compilation. After this call, all framework handler keys (policy-lookup, schema-parse, store-*, emit-broker, audit-*, observe-*, respond-shaper) resolve from the Handler() backend.

## Output entity definitions

Pipeline concerns write to three output entities:

- **`emit_records`** — Domain event log. Persistent, cursor-driven by the subscription processor. Separate entity because it's operationally hot.
- **`execution_log`** — Audit and observe output. Persistent with `Append()` payload column. Shared with subscription output ([04b](04b-append-storage-and-execution-log.md)). Heavy payloads in append files; queryable metadata in database columns.
- **`rate_limit_records`** — Rate limit counters. Volatile. Separate entity because it's structurally different (counters, not execution records).

```ts
const emitRecords = define('emit_records', {
  schema: {
    source: Str({ required: true }),
    entityId: Str(),
    descriptor: Str({ required: true }),
    record: Json(),
    before: Json(),
    identity: Json({ required: true }),
    cursor: Int({ required: true }),
    correlationId: Str({ required: true }),
    timestamp: DateTime({ required: true }),
  },
  storage: Persistent(),
  description: 'Domain event log',
});

const rateLimitRecords = define('rate_limit_records', {
  schema: {
    key: Str({ required: true }),
    count: Int({ required: true }),
    windowStart: DateTime({ required: true }),
  },
  storage: Volatile(),
  description: 'Rate limit counters',
});
```

`execution_log` is defined in [04b](04b-append-storage-and-execution-log.md). These are origin=framework entities, included automatically in compilation.

## Testing gate

When 124-05 is implemented, the following should be testable:

- **Policy:** Admin identity allowed all operations; user identity restricted per rules; anonymous allowed read when `anonymousRead: true`; anonymous denied writes; ownership field set on context
- **Rate-limit:** Counter increments per identity+entity; rejects when max exceeded within window; resets after window expires
- **Parse:** Required fields enforced on create; unknown fields stripped; type coercion applied
- **Validate:** Lifecycle transitions checked (legal allowed, illegal rejected); before-record fetched for updates; ownership enforced when policy sets ownershipField; lifecycle defaults stamped on create
- **Invariant:** Predicate returning false with severity 'error' throws; severity 'warning' captured in outboundErrors
- **Emit:** Event written to emit:records; broker notified; correct event descriptor for each operation
- **Audit:** Audit row written to `execution_log` with handler='audit-relational', before/after in payload; only for configured event types; skipped when not in `on` list
- **Observe:** Observe row written to `execution_log` with handler='observe-memory', retention='7d'; best-effort; errors captured not thrown
- **Respond:** Result shaped correctly for record, page, output, and void result kinds
- **All adapters** receive config from participation record via `ctx.config`
- **seedHandlers()** registers complete framework handler catalog in Handler() backend
