# 124-02: Wiring Functions

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records and define)
**Vocabulary:** All typed constructors referenced here are imported from `@janus/vocabulary`.

## Scope

This sub-ADR specifies:
- `Handler()` column type — resolves function references from a runtime registry (backend-resolved, like `Asset()`, `Append()`, `Template()`)
- `handler()` — registration function for handlers in the runtime backend
- `ParticipationRecord` — the entity-to-handler junction, carrying pipeline placement metadata and per-entity config
- `participate()` — produces participation records, with implicit defaults and inline action declarations
- Framework-seeded handler catalog
- How cluster dissolves into operation-filtered participation records

This sub-ADR does NOT cover:
- Subscription records and `subscribe()` ([07](07-subscriptions-broker-scheduler.md))
- Binding records and `bind()` ([10](10-presentation-and-binding.md))
- Compilation and dispatch index assembly ([03](03-compile-and-dispatch-index.md))
- Pipeline adapter implementations ([05](05-pipeline-concern-adapters.md))
- Store adapter routing like `persist_routing` ([04](04-store-adapters-and-crud.md))

## Handler() column type

The `Handler()` semantic type is one of five backend-resolved columns alongside `Asset()` ([08b](08b-assets-and-media.md)), `Append()` ([04b](04b-append-storage-and-execution-log.md)), `Template()` ([10b](10b-template-column-type-and-rendering.md)), and `Channel()` ([12a](12a-connection-protocol-and-sync.md)):

| Column type | DB stores | Backend | Resolves to |
|-------------|-----------|---------|-------------|
| `Asset()` | `{ backend, path }` | File system / S3 | Metadata + URL |
| `Append()` | `{ file, offset }` | JSONL files | Parsed JSON |
| `Template()` | `{ path }` | Template files | Source string |
| `Handler()` | key string | Runtime function registry | Function reference |

The runtime function registry stores `{ function, description }` keyed by string. The description enables agent discovery — the agent can inspect available handlers and what they do.

**Write path:** `handler()` registers the function + description in the runtime registry and returns the key.

**Resolve path:** At compile time, every `Handler()` column on participation, subscription, and binding records is resolved — the key is looked up in the runtime registry and replaced with the actual function. An unresolved key is a hard compile error.

There is no `execution` entity or table. Handler() keys on junction records (participation, subscription, binding) reference the runtime registry directly. What other frameworks model as a "handler registry entity" is simply a backend-resolved column type — the same abstraction used for files, templates, and append payloads.

```ts
type ExecutionHandler = (ctx: DispatchContext) => Promise<void>;
```

### handler() registration function

```ts
function handler(
  id: string,
  fn: ExecutionHandler,
  description: string,
): string  // returns the handler key
```

Registers the function and description in the Handler() backend. Returns the key (which is `id`). Called at module load time for framework handlers, and by `participate()` for inline action handlers.

```ts
// Framework handler registration (at module load)
handler('schema-parse', schemaParse, 'Schema-driven input parsing and coercion');
handler('store-create', storeCreateHandler, 'Create entity record');
handler('audit-relational', auditHandler, 'Write audit records to execution log');

// Action handler registration (via participate() — see inline actions below)
// handler('note:pin', pinHandler, 'Pin a note to the top of the list');
```

### Framework-seeded handler catalog

| Handler key | Description | Default order | Default transactional | Purpose |
|-------------|-------------|---------------|----------------------|---------|
| `policy-lookup` | Hash-map policy rule evaluation | 10 | false | Authorization |
| `rate-limit-check` | Rate counter check against limits | 11 | false | Rate limiting |
| `schema-parse` | Schema-driven input parsing and coercion | 20 | false | Parsing |
| `schema-validate` | Schema + lifecycle + ownership validation | 25 | false | Validation |
| `invariant-check` | Run invariant predicate functions | 26 | false | Invariants |
| `store-read` | Read entity records (id → single, no id → filtered list) | 35 | false | Core read |
| `store-create` | Create entity record | 35 | true | Core create |
| `store-update` | Update entity record | 35 | true | Core update |
| `store-delete` | Delete entity record | 35 | true | Core delete |
| `emit-broker` | Write event log + notify broker | 40 | true | Events |
| `audit-relational` | Write audit records to execution log | 50 | true | Audit |
| `audit-memory` | Write audit records to memory | 50 | false | Audit (test/volatile) |
| `observe-memory` | Write observation records to memory | 50 | false | Observation |
| `respond-shaper` | Shape dispatch result into response | 70 | false | Response |

Transport handlers (http-receive, http-identity, http-respond, agent-receive, etc.) are specified in [08](08-http-surface-and-bootstrap.md) and [09](09-agent-surface-and-session.md).

Implementation of each adapter is specified in [05](05-pipeline-concern-adapters.md).

The "default order" and "default transactional" columns are not stored on a handler record — they are the values `participate()` uses when generating participation records. The handler itself is just a function + description in the runtime registry.

### seedHandlers()

Registers all framework-seeded handlers in the runtime registry:

```ts
function seedHandlers(): void
```

Called during bootstrap, before compilation. After this call, all framework handler keys resolve from the Handler() backend.

## ParticipationRecord

The junction that connects a graph-node to a handler, carrying pipeline placement metadata and per-entity configuration:

```ts
interface ParticipationRecord {
  readonly source: string;              // Reference → GraphNodeRecord.name
  readonly handler: string;             // Handler() key → runtime function registry
  readonly order: number;               // pipeline position (set by participate() defaults or consumer override)
  readonly transactional: boolean;      // tx boundary (set by participate() defaults or consumer override)
  readonly config: Readonly<Record<string, unknown>>;
  readonly operations?: readonly Operation[];  // which operations this applies to
}
```

| Field | Description |
|-------|-------------|
| `source` | The entity this participation is for. Reference to a graph-node name. |
| `handler` | `Handler()` key — resolves to a function from the runtime registry at compile time. |
| `order` | Pipeline position. Set by `participate()` from handler defaults (e.g., `schema-parse` → 20). Consumer can override. |
| `transactional` | Whether this handler runs inside the transaction boundary. Determines preTx/tx/postTx partition (see [03](03-compile-and-dispatch-index.md)). Set by `participate()` from handler defaults. |
| `config` | Per-entity configuration for the handler's adapter. Shape depends on the handler (e.g., policy rules, audit level, rate limit parameters). |
| `operations` | Optional filter: which operations this participation applies to. If omitted, applies to all operations the entity supports. |

### Cluster dissolution

In packages/next, `cluster` (read/write/action) was a field that filtered which pipeline stages applied at dispatch time. In the participation model, this filtering moves to declaration time.

When `participate()` generates participation records, it applies operation filtering based on the handler's semantics:

| Handler | Default operations filter |
|---------|--------------------------|
| `policy-lookup` | All operations |
| `rate-limit-check` | All operations |
| `schema-parse` | `create`, `update` (writes need input parsing) |
| `schema-validate` | `create`, `update` (writes need validation) |
| `invariant-check` | `create`, `update` (writes need invariant checks) |
| `store-read` | `read` |
| `store-create` | `create` |
| `store-update` | `update` |
| `store-delete` | `delete` |
| `emit-broker` | `create`, `update`, `delete` (writes emit events) |
| `audit-*` | `create`, `update`, `delete` (writes are audited) |
| `observe-memory` | Configured per-entity |
| `respond-shaper` | All operations |

The consumer can override these defaults:

```ts
participate('note', {
  audit: { level: AuditFull, operations: '*' },  // all operations (including reads)
  // vs
  audit: AuditFull,  // default: writes only
});
```

## participate()

Produces participation records for an entity, with standard pipeline defaults included automatically:

```ts
function participate(
  entity: string | DefineResult,
  config: ParticipateConfig,
): ParticipateResult
```

### ParticipateConfig

```ts
interface ParticipateConfig {
  // ── Override/add (consumer provides these)
  readonly policy?: PolicyConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly audit?: AuditConfig | AuditLevel;
  readonly observe?: ObserveConfig;
  readonly invariant?: readonly InvariantInput[];

  // ── Opt-out (defaults are included automatically; set false to exclude)
  readonly parse?: false;
  readonly validate?: false;
  readonly emit?: false;
  readonly respond?: false;

  // ── Inline actions
  readonly actions?: Record<string, ActionConfig>;
}
```

### Implicit defaults

`participate()` automatically includes participation records for: `schema-parse`, `schema-validate`, CRUD handlers (derived from the entity's operation set), `emit-broker`, and `respond-shaper`. The consumer does not need to opt into these — they are the standard pipeline.

Each default participation record gets its `order` and `transactional` values from the handler catalog defaults (e.g., `schema-parse` → order 20, transactional false).

The entity's operation set (from `GraphNodeRecord.operations`) further filters which CRUD handlers are included. For example, a `Derived()` entity with `operations: ['read']` will only get `store-read` participation — even though defaults include all four CRUD handlers.

The consumer adds optional concerns (policy, rateLimit, audit, observe, invariant) via config keys. Omitting a key means "do not participate in this concern."

The consumer opts out of defaults by setting them to `false`:

```ts
// Standard defaults + audit + policy
participate('note', {
  audit: AuditFull,
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'user', operations: ['read', 'create'], ownershipField: 'authorId' },
    ],
    anonymousRead: true,
  },
});
// Produces ~10 participation records:
// policy-lookup (all ops), schema-parse (writes), schema-validate (writes),
// store-read, store-create, store-update, store-delete,
// emit-broker (writes), respond-shaper (all ops),
// audit-relational (writes)

// Opt out of emit
participate('note', { emit: false });
// No emit-broker participation — events are not emitted for this entity
```

### ParticipateResult

```ts
interface ParticipateResult {
  readonly kind: 'participate';
  readonly records: readonly ParticipationRecord[];
}
```

`participate()` resolves the entity name (from string or `DefineResult`), generates one `ParticipationRecord` per included handler (defaults + overrides - opt-outs + actions), applies operation filtering, and returns the result. When inline actions are declared, the handler is registered in the Handler() backend as a side effect.

### Config types (carried forward from vocabulary)

```ts
interface PolicyConfig {
  readonly rules: readonly PolicyRuleInput[];
  readonly anonymousRead?: boolean;
}

interface PolicyRuleInput {
  readonly role: string;
  readonly operations: readonly Operation[] | '*';
  readonly ownershipField?: string;
}

interface RateLimitConfig {
  readonly max: number;
  readonly window: number; // milliseconds
}

// AuditConfig, EmitConfig, ObserveConfig, ParseConfig, ValidateConfig, RespondConfig
// carried forward from @janus/vocabulary capability constructors
```

## Inline actions

Custom operations are declared via the `actions` key on `ParticipateConfig`. For each action, `participate()`:

1. **Registers the handler** in the Handler() backend — key: `'${entity}:${actionName}'`, function + description from config
2. **Creates a ParticipationRecord** — `source: entity`, `handler: '${entity}:${actionName}'`, `order: 35`, `transactional: kind === 'mutation'`, config from action

### ActionConfig

```ts
interface ActionConfig {
  readonly handler: ExecutionHandler;
  readonly kind: ActionKind;
  readonly scoped?: boolean;
  readonly description?: string;
  readonly inputSchema?: Record<string, SchemaField>;
}

type ActionKind = 'query' | 'mutation' | 'effect';
```

| Field | Description |
|-------|-------------|
| `handler` | The action's handler function. Registered in the Handler() backend by `participate()`. |
| `kind` | `'query'` (read-only), `'mutation'` (scoped write), `'effect'` (side-effect, e.g., send email). Determines transactional behavior. |
| `scoped` | If true, the action operates on a specific record (requires entityId). |
| `description` | Human-readable description for agent discovery. Stored in Handler() backend alongside the function. |
| `inputSchema` | Optional schema for action-specific input validation. |

### Example

```ts
participate('note', {
  policy: { rules: [{ role: 'admin', operations: '*' }] },
  audit: AuditFull,
  actions: {
    pin: {
      handler: async (ctx) => { /* pin logic */ },
      kind: 'mutation',
      scoped: true,
      description: 'Pin a note to the top of the list',
    },
    export: {
      handler: async (ctx) => { /* export logic */ },
      kind: 'query',
      description: 'Export note as PDF',
    },
  },
});
// Registers handlers: 'note:pin', 'note:export' in Handler() backend
// Produces participation records:
//   standard defaults + policy + audit
//   + { handler: 'note:pin', order: 35, transactional: true, ... }
//   + { handler: 'note:export', order: 35, transactional: false, ... }
```

## Pipeline ordering summary

The full order spectrum for a typical entity:

```
  5    Transport: receive         (from initiator, see 08/09)
  6    Transport: identity        (from initiator)
 10    policy-lookup              (pre-core, non-tx)
 11    rate-limit-check           (pre-core, non-tx)
 20    schema-parse               (pre-core, non-tx)
 25    schema-validate            (pre-core, non-tx)
 26    invariant-check            (pre-core, non-tx)
 35    CORE: store-read/create/update/delete/action  (one per dispatch)
 40    emit-broker                (post-core, tx for writes)
 50    audit-*                    (post-core, tx for writes)
 50    observe-memory             (post-core, non-tx)
 70    respond-shaper             (post-core, non-tx)
 80    Transport: respond         (from initiator)
```

Gaps between orders (10→11, 20→25→26, etc.) allow consumers to insert custom handlers. The space between 26 and 35 (8 slots) and between 50 and 70 (19 slots) provide the most room for extension.

## Testing gate

When 124-02 is implemented, the following should be testable:

- `handler()` registers a function + description in the Handler() backend and returns the key
- Handler() key resolves to registered function at compile time
- Unresolved Handler() key produces a hard compile error
- Handler() backend stores description alongside function (agent-discoverable)
- `participate('note', {})` with no config produces standard default participation records with correct handler keys, order, and transactional values
- `participate('note', { audit: AuditFull })` adds audit participation for write operations only
- `participate('note', { policy: { rules: [...] } })` adds policy participation for all operations
- `participate('note', { audit: { level: AuditFull, operations: '*' } })` adds audit for ALL operations
- `participate('note', { emit: false })` excludes emit-broker from participation
- `participate()` for a `Derived()` entity produces only `store-read` participation (filtering based on entity's operation set)
- `participate('note', { actions: { pin: { ... } } })` registers handler 'note:pin' in backend and produces participation record
- Action participation has `order: 35` and `transactional` matching the action kind
- All returned records are frozen
- Framework-seeded handlers available via `seedHandlers()`
- Participation records carry correct `operations` filter per handler semantics
