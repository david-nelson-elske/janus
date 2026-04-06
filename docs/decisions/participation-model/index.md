# ADR-124: Participation Model — Entity-Mediated Pipeline Wiring

**Status:** Draft
**Date:** 2026-04-02
**Deciders:** David (Web/IT representative)
**Depends on:** ADR-123 (Entity-Native Framework)
**Builds on lessons from:** packages/next/ Phase 1 implementation

## Context

### What we learned building packages/next

ADR-123 established the principle: everything is an entity. Phase 1 proved the entity vocabulary, storage strategies, route derivation, and the compile-then-freeze model. 639 tests pass. The core is solid.

But the layer between entity definition and pipeline dispatch — how an entity's declarations become runtime behavior — accumulated inconsistencies as concepts were introduced quickly:

**Six wiring mechanisms.** Entity-to-entity data uses Relation fields. Entity-to-step config uses a `Map<string, StepConfig>`. Entity-to-action binding uses an array accumulator. Entity-to-event subscriptions use a reactions array. Entity-to-infrastructure uses naming convention (`audit-${name}`). Transport chain uses `next` edge walking. Each was introduced for a specific need but they don't share a model.

**StepDefinition carries too many responsibilities.** Each step definition simultaneously: owns infrastructure entities, derives per-entity entities, provides adapter routing, provides tool mappings, and compiles pipeline stage closures. Five concerns in one interface.

**The inbound/execution/outbound config grouping leaks pipeline internals into the consumer API.** The consumer must know that `observe` can appear in three different config blocks and that `policy` is "inbound" while `audit` is "execution." These are framework concerns, not consumer concerns.

**Invariants bypass the step config path.** They're declared in `execution.validate.invariants` but extracted into `_invariants` on the EntityHandle, then read from `entity.declarations.invariants` by the validate step. The "step config" abstraction has a hole.

**Policy isn't a step.** It's checked in `dispatch.ts` via `preDispatchGate()` before any pipeline runs, but lives in `inbound` on the config as if parallel to parse/validate.

**N infrastructure entities per domain entity.** `deriveEntities()` generates `audit-note`, `observe-note`, `audit-venue`, `observe-venue`, etc. For 10 domain entities with 5 concerns, that's 50+ generated entities. The infrastructure cost grows linearly with domain entities.

**Two separate compilation phases.** `compile()` builds the registry, then `compileDispatchIndex()` builds the dispatch index from the registry. They could be one thing.

### The root cause

These aren't independent problems. They share a root cause: **the framework uses Relation as the wiring primitive for data edges but uses ad-hoc mechanisms for everything else.** Steps, policy, actions, reactions, infrastructure — all wired through bespoke code paths instead of through the entity graph.

The transport chain already proved a better model: entities connected by Relation edges, walked at runtime. One entity's handler produces output, the next entity in the chain consumes it. The pipeline IS the graph walk. But this pattern wasn't generalized to the rest of the framework.

### What this ADR proposes

Generalize the transport chain pattern to the entire pipeline. Make every pipeline concern an entity record. Wire domain entities to their concerns through a junction entity. Assemble the pipeline by walking the entity graph.

The result: one wiring mechanism (Relation/Reference), one compilation model (graph walk), and fixed infrastructure overhead regardless of domain entity count.

## Decision

### 1. Two declarations, not one

Entity definition and pipeline participation are separate declarations because they change for different reasons.

**Definition** — what the entity IS. Schema, storage strategy, and the structural identity that determines which operations exist:

```ts
const note = define('note', {
  schema: {
    title: Str({ required: true }),
    body: Str(),
    author: Relation('user'),
    status: Lifecycle({
      states: ['draft', 'published', 'archived'],
      initial: 'draft',
      transitions: { draft: ['published'], published: ['archived'] },
    }),
  },
  storage: Persistent(),
});
```

**Participation** — how the entity engages pipeline concerns. Each consumer function targets a specific table:

```ts
// Pipeline concerns → participation records (defaults included automatically)
participate(note, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'user', operations: ['read', 'create'], ownershipField: 'authorId' },
    ],
    anonymousRead: true,
  },
  audit: AuditFull,
  observe: { on: [Created, Updated] },
  invariant: [
    { name: 'title-not-empty', predicate: (r) => r.title?.length > 0 },
  ],
  actions: {
    pin: { kind: 'mutation', scoped: true, handler: pinHandler },
  },
});

// Subscriptions → subscription records (event/cron wiring)
subscribe(note, [
  { on: Created, handler: 'dispatch', config: { entity: 'feed', action: 'notify' } },
  { on: Created, handler: 'webhook', config: { url: 'https://...', method: 'POST' } },
  { cron: '0 0 * * *', handler: 'dispatch', config: { entity: 'note', action: 'purge-drafts' } },
]);

// Presentation → binding records (direct component references + field metadata)
bind(note, [
  { component: NoteDetail, view: 'detail', config: {
    fields: { title: { component: 'heading', agent: 'read-write' }, body: { component: 'richtext', agent: 'read-write' } },
  }},
  { component: NoteList, view: 'list', config: {
    columns: ['title', 'status', 'author'],
    fields: { title: { agent: 'read' }, status: { agent: 'read' }, author: { agent: 'read' } },
  }},
]);
```

Each function produces records for its table:
- **`participate()`** → participation records (pipeline wiring)
- **`subscribe()`** → subscription records (event/schedule wiring)
- **`bind()`** → binding records (presentation wiring)

A schema change doesn't touch participation. A policy change doesn't touch the schema. Custom infrastructure wiring doesn't require editing the entity definition. Multiple participation strategies can target the same entity definition.

### 2. Four core tables

The framework's infrastructure is modeled as four entities: one reference table and three junction tables.

#### graph-node — entity definitions

Every `define()` call produces a record in the `graph-node` entity. This is already true in packages/next — compile() already generates graph-node records. The change is that graph-node becomes the authoritative entity registry, not a side effect of compilation.

```
graph-node records:
  name=note    origin=consumer    schema={...}  storage=Persistent()
  name=venue   origin=consumer    schema={...}  storage=Persistent()
```

The `origin` field replaces the packages/next concepts of `realm` and `kind`:

- **`origin`** (framework | consumer) — who defined this entity. Framework entities are seeded by the framework. Consumer entities are defined by the application. This replaces `realm` (domain/framework/operational). The three-way realm distinction was an implementation artifact — what matters is whether the framework or the consumer owns the definition, for purposes of discovery filtering and safe modification.

- **`kind` is removed.** In packages/next, kind (server/transport/client) determined pipeline shape and available operations. In the participation model: pipeline shape is determined by participation records, available operations are derived from schema + storage + participation, and transport dissolved into participation records with transport-level ordering (see Decision 9). An entity with no participation is effectively a "client." An entity participating in transport handlers is effectively a "transport surface." The participation records tell you what the entity does — kind is redundant.

#### Handler() — runtime function resolution

There is no separate execution entity or table. Handler functions are referenced by string key on junction records (participation, subscription, binding) via the `Handler()` column type. At runtime, the handler key resolves from a function registry — a volatile map of `string → function`. At build time, functions are registered into the registry by `participate()`, `subscribe()`, and `bind()`. The framework seeds default handlers (pipeline concern adapters, CRUD handlers, transport adapters); consumers register custom handlers (actions, subscription handlers).

Pipeline placement metadata — `order` and `transactional` — lives directly on the participation record, not on a shared handler definition. This means the same handler function can appear at different order positions for different entities if needed.

**Core operation handlers are participation records at order=35.** The four CRUD operations — `read`, `create`, `update`, `delete` — are participation records at `order=35`, each pointing to a core handler function. Only one core handler runs per dispatch — the one matching the requested operation. `read` is parameterized: if an `id` is provided, it returns a single record; otherwise it returns a filtered list with pagination. This collapses the traditional browse/get distinction into one operation. The core handlers use `persist_routing` (see Decision 11) to resolve the storage adapter for each entity. There is no standalone "persist" stage — the CRUD handler IS the core stage, and it handles persistence internally. Each write operation (create, update, delete) supports both single and bulk cardinality.

**Phase is removed.** Order determines execution sequence. `transactional` determines the tx boundary. Phase is derivable from order position relative to core (order < 35 = before core, order = 35 = core, order > 35 = after core) but is not stored.

**Order** is an integer on the participation record representing the execution position. Two participation records with the same order value are independent — they may run in either order, and in the future could be parallelized.

Actions are participation records with `order=35`. The pipeline for `note:pin` is assembled the same way as `note:create`: same graph walk, same assembly.

The set of handlers is open. Consumers can register new handler functions. This enables experimentation — register a new handler, wire it to one entity via participation, iterate.

#### participation — pipeline wiring junction

The `participation` entity is the junction that connects a graph-node record to a handler, carrying per-entity configuration and pipeline placement. This is the enrollment table.

```
participation records:
  # Cross-cutting pipeline concerns
  source → note    handler → policy-lookup     order=10  transactional=false  config={ rules: [...], anonymousRead: true }
  source → note    handler → rate-limit-check  order=11  transactional=false  config={ max: 100, window: 60000 }
  source → note    handler → schema-parse      order=20  transactional=false  config={}
  source → note    handler → schema-validate   order=25  transactional=false  config={}
  source → note    handler → invariant-check   order=26  transactional=false  config={ predicates: [...] }
  source → note    handler → emit-broker       order=40  transactional=true   config={}
  source → note    handler → audit-relational  order=50  transactional=true   config={ level: 'full', on: [Created, Updated, Deleted] }
  source → note    handler → observe-memory    order=50  transactional=false  config={ on: [Created, Updated] }
  source → note    handler → respond-shaper    order=70  transactional=false  config={}

  # Core handlers (generated by participate() defaults from schema + storage)
  source → note    handler → store-read        order=35  transactional=false  config={}
  source → note    handler → store-create      order=35  transactional=true   config={}
  source → note    handler → store-update      order=35  transactional=true   config={}
  source → note    handler → store-delete      order=35  transactional=true   config={}

  # Custom actions (inline on participate())
  source → note    handler → note:pin          order=35  transactional=true   config={ kind: 'mutation', scoped: true }

  # Venue — different handler set
  source → venue   handler → policy-lookup     order=10  transactional=false  config={ rules: [...] }
  source → venue   handler → audit-memory      order=50  transactional=false  config={ level: 'summary' }
  source → venue   handler → store-read        order=35  transactional=false  config={}
  source → venue   handler → store-create      order=35  transactional=true   config={}
  source → venue   handler → store-update      order=35  transactional=true   config={}
  source → venue   handler → venue:sync-gcal   order=35  transactional=false  config={ calendarId: '...', apiKey: '...' }
```

`source` is a Reference field — a soft pointer to a record in the `graph-node` entity. `handler` is a Handler() field — a string key that resolves to a function from the runtime handler registry.

#### subscription — event and schedule wiring junction

The `subscription` entity is a second junction that connects a graph-node record to a trigger and a handler. This absorbs what packages/next modeled as reactions, and generalizes to cover webhooks, SSE streams, notifications, and scheduled operations.

Every subscription has the same shape: **trigger → handler → config → failure.** The trigger type determines when it fires (entity event or cron schedule). The handler determines what happens (internal dispatch, HTTP call, stream push, notification delivery). The failure policy (`log` or `retry`) determines what happens when the handler fails. Subscriptions carry a Handler() key directly — the trigger and config on the junction record carry all the metadata needed.

```
subscription records:

  # Reactions (event → internal dispatch)
  source → note    trigger={ kind: 'event', on: Created }
                   handler → dispatch-adapter   config={ entity: 'feed', action: 'notify' }   failure=log

  # Webhooks (event → external HTTP call)
  source → note    trigger={ kind: 'event', on: Created }
                   handler → webhook-sender     config={ url: 'https://...', method: 'POST' }  failure=retry

  # SSE (event → stream push)
  source → note    trigger={ kind: 'event', on: Updated }
                   handler → stream-pusher      config={ channel: 'note-updates' }             failure=log

  # Notifications (event → delivery channel)
  source → note    trigger={ kind: 'event', on: Created }
                   handler → notify-sender      config={ template: 'new-note', via: 'email' }  failure=retry

  # Scheduled sync (cron → dispatch action)
  source → venue   trigger={ kind: 'cron', expr: '*/15 * * * *' }
                   handler → dispatch-adapter   config={ entity: 'venue', action: 'sync-gcal' }  failure=retry

  # Scheduled cleanup (cron → dispatch action)
  source → note    trigger={ kind: 'cron', expr: '0 0 * * *' }
                   handler → dispatch-adapter   config={ entity: 'note', action: 'purge-drafts' }  failure=log
```

`source` is a Reference to a graph-node record. `handler` is a Handler() key that resolves from the runtime function registry. The broker reads subscription records with event triggers. The scheduler reads subscription records with cron triggers. Both resolve the handler and call it.

Subscriptions are fundamentally different from participation: participation wires stages INTO a dispatch pipeline (synchronous, ordered, within a single dispatch). Subscriptions wire triggers AFTER or OUTSIDE dispatch (asynchronous, event-driven or time-driven, triggering new dispatches). This is why they are a separate junction.

**What v1 operational entities become:**

| v1 entity | Subscription model equivalent |
|-----------|------------------------------|
| Reaction declaration | subscription: handler=dispatch-adapter, trigger=event |
| `_reaction-processor` | Broker reads subscription records with trigger.kind='event' |
| `_schedule` / `_schedule-processor` | Scheduler reads subscription records with trigger.kind='cron' |
| Webhook delivery | subscription: handler=webhook-sender, trigger=event |
| SSE connection | subscription: handler=stream-pusher, trigger=event |
| Connector sync schedule | subscription: handler=dispatch-adapter, trigger=cron + action handler |

### 3. Pipeline assembly is an initiator join

The dispatch pipeline for a given (initiator, entity, operation) triple is assembled by joining the initiator's participation records with the entity's participation records, then sorting and partitioning.

**The join formula:**

```
pipeline(initiator, entity, operation) =
  sort(initiator.participation ∪ entity.participation(operation))
```

**Example — `api-surface` dispatching `note:create`:**

```
1. Resolve initiator: graph-node where name = 'api-surface'
   → query participation: where source = 'api-surface'
   → handlers: http-parse (5), jwt-identity (6), http-shaper (80)

2. Resolve entity: graph-node where name = 'note'
   → derive operation set from schema + storage
   → confirm 'create' is a valid operation
   → query participation: where source = 'note', filtered to 'create'
   → handlers: policy-lookup (10), rate-limit-check (11), schema-parse (20),
               schema-validate (25), invariant-check (26), store-create (35),
               emit-broker (40), audit-relational (50), observe-memory (50),
               respond-shaper (70)

3. Join: union both handler sets
   → sort by effective order (participation.order)

4. Partition by transactional flag:
   preTx:  http-parse (5), jwt-identity (6), policy-lookup (10), rate-limit-check (11),
           schema-parse (20), schema-validate (25), invariant-check (26)
   tx:     store-create (35), emit-broker (40), audit-relational (50)
   postTx: observe-memory (50), respond-shaper (70), http-shaper (80)

5. For each stage: resolve handler from registry, pass participation.config
   → assemble TransactionPipeline { preTx, tx, postTx, needsTx: true }
```

**Example — `api-surface` dispatching `note:read`:**

```
preTx:  http-parse (5), jwt-identity (6), policy-lookup (10), schema-parse (20)
tx:     (empty — read is transactional=false)
postTx: store-read (35), respond-shaper (70), http-shaper (80)
→ needsTx: false — the whole sequence runs as a flat non-transactional pass
```

**Example — `system` dispatching `note:create`:**

```
system has no participation records, so the join is just note's handlers:
preTx:  policy-lookup (10), rate-limit-check (11), schema-parse (20), schema-validate (25), invariant-check (26)
tx:     store-create (35), emit-broker (40), audit-relational (50)
postTx: observe-memory (50), respond-shaper (70)
```

**Partition rule.** The transactional flag cleanly partitions the joined list. For writes (create/update/delete), the core handler is `transactional=true`, so the tx group contains the core handler plus any subsequent transactional participation records (emit, audit). Everything before is preTx, everything non-transactional after is postTx. For reads, no participation records are transactional, so `needsTx=false` and the entire sequence runs without a transaction boundary. There is never ambiguity at order=35 because only one core handler (the one matching the operation) appears in any given pipeline.

**Routing is compile-time.** There is no runtime routing step. The join of initiator + entity participation IS the routing — it determines which pipeline to execute. At runtime, the initiator parses the inbound request (e.g. HTTP URL) to determine the target entity and operation, then looks up the frozen pipeline by `(initiator, entity, operation)`. This eliminates `http-router` as a pipeline concern.

At compile time, this join is performed once per (initiator, entity, operation) triple and frozen into the dispatch index (see Decision 21). At runtime, dispatch looks up the frozen pipeline — no graph walking or joining on the hot path.

### 4. Pipeline and subscription output: execution_log + emit_records

Pipeline adapters and subscription adapters that produce data write to shared output entities — not per-domain-entity entities.

**Two output entities:**

| Entity | Written by | Purpose | Storage |
|--------|-----------|---------|---------|
| `emit_records` | emit pipeline adapter | Domain event log — drives subscriptions | Persistent (cursor-driven, operationally hot) |
| `execution_log` | audit, observe, tracked subscription adapters | What happened during execution | Persistent + Append() payload |

`emit_records` stays separate because the subscription processor reads it with a cursor — it's operationally hot and structurally distinct. Everything else is execution history: audit trails, observation metrics, webhook delivery records, connector sync results, dead-lettered work. These share a common pattern (an execution ran, here's what happened) and are consolidated into `execution_log` with per-row retention and file-backed payloads via `Append()`. See [04b](04b-append-storage-and-execution-log.md).

The `handler` field on each `execution_log` row identifies what wrote it (`'audit-relational'`, `'observe-memory'`, `'webhook-sender'`, etc.). The `source` field provides per-entity filtering. This replaces the current model of generating `audit-note`, `audit-venue`, etc.

A third output entity, `rate_limit_records`, holds volatile rate-limit counters — structurally different from execution records.

### 5. What dissolves

The following concepts from packages/next are replaced by the participation model:

| Concept | Replaced by |
|---------|-------------|
| `EntityHandle._stepConfigs: Map<string, StepConfig>` | participation records |
| `StepDefinition` interface | Handler() on participation records + adapters |
| `StepDefinition.deriveEntities()` | `participate()` generating participation records |
| `StepDefinition.compile()` → closure | Handler resolved from registry at compile time |
| `StepDefinition.seedRoutes()` / `seedMappings()` | Derived from participation records |
| `inbound/execution/outbound` config grouping | Order field on the participation record |
| `phase` field | Derived from order position (not stored) |
| `registerAdapter()` in-memory map | Handler() runtime registry (discoverable) |
| `kind` field (server/transport/client) | Determined by participation records |
| `realm` (domain/framework/operational) | Simplified to `origin` (framework/consumer) |
| `compileDispatchIndex()` as separate phase | Graph walk during `compile()` |
| Per-entity infrastructure entities (`audit-note`, `observe-note`) | Shared `execution_log` entity (filterable by `handler` + `source`) |
| `EntityHandle` mutable accumulators | Immutable records in graph-node + participation |
| Policy as special-case pre-dispatch gate | Policy as a pipeline concern (order=10) |
| Rate limiting as special-case check | Rate-limit as a pipeline concern (order=11) |
| Invariants inside validate step config | Invariant as a pipeline concern (order=26) |
| Naming convention wiring (`audit-${name}`) | Reference edges in the participation junction |
| Transport entity kind | Initiators (surfaces + system) with transport handlers |
| Transport chain `next` edge walking | Initiator join at compile time (Decision 3) |
| Runtime routing step (`http-router`) | Compile-time join IS the routing (Decision 9) |
| Nested dispatch (transport wrapping domain) | Flat pipeline from initiator + entity participation join |
| `_reaction-processor` entity | Broker reads subscription records |
| `_schedule-processor` entity | Scheduler reads subscription records |
| `ConcernRecord` type | Absorbed into ParticipationRecord (order + transactional fields) |
| `concern()` registration function | Absorbed into `participate()` which now includes pipeline placement |
| `withDefaults()` helper | Absorbed into `participate()` as implicit defaults |
| `actions()` separate function | Absorbed into `participate()` via `actions` config key |
| `PresentationRecord` type | Absorbed into BindingRecord |
| `presentation()` registration function | Replaced by `bind()` with direct component references |
| `defineView()` / presentation packages | `bind()` + component imports |
| Projection system | Complex views handled as Derived() entities; binding layer stays trivial |

### 6. Compile is pure; participate provides defaults

`compile()` is a pure function from records → dispatch-index records. It does not auto-generate anything. It takes the core tables as input and produces frozen dispatch-index records as output.

Default participation (parse, validate, core handlers, emit, respond) is handled by `participate()` itself — it automatically includes standard pipeline defaults. The consumer adds optional concerns (policy, audit, observe, invariant, rateLimit) and overrides or opts out of defaults. This keeps compile simple and makes defaults explicit at the participation call site:

```ts
const registry = compile([
  // Entity definitions → graph-node records
  define('note', { schema: {...}, storage: Persistent() }),
  define('venue', { schema: {...}, storage: Persistent() }),
  define('user', { schema: {...}, storage: Persistent() }),

  // Participation — participate() adds parse, validate, core handlers, emit, respond automatically
  participate('note', {
    audit: AuditFull,
    observe: { on: [Created] },
    policy: { rules: [...] },
    actions: { pin: { handler: pinHandler, kind: 'mutation', scoped: true } },
  }),
  participate('venue', { audit: AuditSummary, policy: { rules: [...] } }),
  participate('user', { audit: AuditFull, policy: { rules: [...] } }),
]);
```

Both definitions and participations flow into `compile()` as a flat list. Compile processes them into the core tables, performs the initiator join for each (initiator, entity, operation) triple, and produces frozen `dispatch-index` records (see Decision 21). The registry is dispatch-ready — `createPipeline(registry)` just wraps the index.

**Runtime recompilation.** Because compile is a pure function from records → dispatch index, the same logic supports hot recompilation. Build-time compilation reads from in-memory declarations. Runtime recompilation reads from the store (where participation records are persisted). The recompilation mechanism is:

1. Read current graph-node, participation, subscription, binding records from store
2. Run the same graph walk → pipeline assembly logic
3. Swap the dispatch index atomically

This means an agent can modify participation records at runtime (e.g. change audit level from summary to full) and trigger recompilation. The participation model is designed to support this — participation records are persistent, the compilation logic is stateless.

### 7. Two-way separation: handler and config

The model cleanly separates two things:
- **Handler** — what runs (the handler function, resolved from registry via Handler() key)
- **Config** — with what settings, when, and where (per-entity config, order, transactional — all on the junction record)

Junction records carry a reference that resolves to executable behavior. For pipeline and subscription junctions, this is a Handler() key that resolves to a server-side function via the runtime registry. For binding junctions, this is a direct TypeScript component reference.

```
Pipeline:      participation.handler → registry → server function
Subscription:  subscription.handler → registry → server function
Binding:       binding.component → direct TypeScript import → client component
```

### 8. Infrastructure entity count is fixed

| Category | Entity | Storage | Count |
|----------|--------|---------|-------|
| Core tables | `graph_node`, `participation`, `subscription`, `binding` | Various | 4 |
| Dispatch | `dispatch_index` | Derived | 1 |
| Event log | `emit_records` | Persistent | 1 |
| Execution log | `execution_log` | Persistent + Append() | 1 |
| Discovery | `query_field`, `search_index` | Derived | 2 |
| Routing | `persist_routing` | Derived | 1 |
| Counters | `rate_limit_records` | Volatile | 1 |
| Session | `session` | Volatile | 1 |
| Real-time | `connection`, `client_subscription` | Volatile | 2 |
| Connector | `connector_binding` | Persistent | 1 |
| Initiators | `system` (framework), consumer-defined surfaces | Singleton | 1 + N |
| Seeded handlers | ~20 handler functions in registry (not entities) | — | 0 |
| Domain entities | Consumer-defined | Various | N |
| **Total infrastructure** | | | **~18 fixed** |

**Entity naming convention:** Entity names use lowercase alphanumeric with underscores for multi-word names (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`). Entity names are directly usable as SQL table names. Framework vs consumer is distinguished by `origin`, not naming convention. See [01](01-core-records-and-define.md) for name validation rules.

`emit_records` is the domain event log — it stays Persistent because the subscription processor reads it with a cursor. All other pipeline and subscription output (audit, observe, webhook delivery, sync results, dead-lettered work) is consolidated into `execution_log` — Persistent storage with an `Append()` payload column for file-backed heavy data. See [04b](04b-append-storage-and-execution-log.md).

**Design rule:** If data drives automatic behavior → strong types in the database. If data records what happened → JSON payload in append files, with a strongly-typed database index for queries.

Compare to packages/next Phase 1: ~28 framework entities + 2-3 generated per domain entity. For 10 domain entities with 5 concerns each, that was ~78 entities. Under the participation model: ~28 (18 infrastructure + ~10 domain), regardless of how many concerns each entity participates in.

The infrastructure entity count is fixed regardless of domain entity count. Adding a 100th domain entity adds zero infrastructure entities — just participation records in existing tables and dispatch-index records recomputed by compile.

### 9. Initiators: surfaces and system

Every dispatch is initiated by something — an HTTP request, an MCP tool call, a subscription handler, a cron job. The **initiator** is the graph-node that represents the source of the dispatch. Initiators contribute their own participation records to the pipeline join (see Decision 3).

There are two kinds of initiators:

**Surfaces** are initiators that add transport handlers — parsing inbound requests, resolving caller identity, and shaping outbound responses. Each surface is a graph-node with participation records for its transport handlers.

**`system`** is a framework-provided initiator for internal dispatch — subscription handlers, scheduler, handler-to-handler calls. It has no participation records by default (the join is just the entity's handlers), but participation records can be added if needed (e.g., a system-identity handler that sets the actor to an elevated system principal).

```
graph-node:
  name=api-surface       origin=consumer    storage=Singleton()
  name=admin-surface     origin=consumer    storage=Singleton()
  name=agent-surface     origin=consumer    storage=Singleton()
  name=system            origin=framework   storage=Singleton()

participation:
  # Public API — JWT auth, CORS
  source → api-surface     handler → http-parse            config={}
  source → api-surface     handler → jwt-identity          config={ method: 'jwt' }
  source → api-surface     handler → http-shaper           config={ cors: true }

  # Admin panel — API key auth
  source → admin-surface   handler → http-parse            config={}
  source → admin-surface   handler → apikey-identity       config={ header: 'X-Admin-Key' }
  source → admin-surface   handler → http-shaper           config={}

  # Agent — tool calling surface (modality configured per-session: voice, text, or mixed)
  source → agent-surface   handler → agent-receive         config={}
  source → agent-surface   handler → agent-identity        config={}
  source → agent-surface   handler → agent-respond         config={}

  # System — no transport handlers (empty by default)
```

Transport handlers follow the same participation pattern as domain pipeline concerns. Different auth strategies use different handlers (`jwt-identity` vs `apikey-identity`). Different surfaces use different receive/respond handlers. No special transport entity kind, no chain-walking mechanism, no `next` edges, no runtime routing step.

**Routing is compile-time.** The join of initiator participation + entity participation IS the routing. There is no `http-router` handler. At runtime, the initiator's receive handler parses the inbound request to determine the target entity and operation, then the dispatch lookup uses the frozen `(initiator, entity, operation)` key to find the pre-assembled pipeline.

**Every entity is reachable from every surface by default.** The compile step produces pipelines for all `(surface, entity, operation)` combinations. For 3 surfaces × 20 entities × 4 operations = 240 frozen pipelines — manageable. If isolation is needed (e.g., admin-only entities), that can be modeled as a scope filter on the surface in a future iteration.

**Agent surface and modality.** The `agent-surface` is how AI models consume the framework — discovering available operations, calling tools, and receiving structured results. Voice is a modality configuration on the agent surface, not a separate surface. The OpenAI Realtime API (and similar) multiplexes across speech/text I/O combinations (speech→text, speech→speech, text→text, text→speech) with tool calling in between. The agent surface handles the tool calling contract; speech-to-text and text-to-speech are adapter-level concerns within the agent's receive/respond handlers, configured per-session. The specific agent handler adapters (receive, identity, respond) and how large models leverage the framework as an agentic harness are implementation-level design work, specified in follow-up ADRs.

### 10. Auth, rate limiting, and invariants are pipeline concerns

In packages/next, policy is a special-case pre-dispatch gate, rate limiting is a special check, and invariants are extracted from validate step config into a separate accumulator. In the participation model, all three are pipeline concerns — same pattern as audit or observe.

**Policy** (order=10): The policy handler performs a hash-map lookup against the participation config's rules. No IO for the common case. Anonymous read, role-based access, ownership filtering — all expressed as config on the participation record.

**Rate limiting** (order=11): The rate-limit handler checks counters against the participation config's limits. Counters are volatile records in a `rate_limit_records` entity. Runs immediately after policy — if you're not authorized, don't bother checking rate limits.

**Invariants** (order=26): The invariant handler runs predicate functions against the proposed record state. Predicates are provided in the participation config. Runs after validate (which handles schema-level validation and lifecycle checks), adding domain-level constraints. This replaces the awkward split where invariants were declared in validate config but extracted into a separate accumulator.

```
participate(note, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }, { role: 'user', operations: ['read', 'create'] }],
    anonymousRead: true,
  },
  rateLimit: { max: 100, window: 60000 },
  invariant: [
    { name: 'title-not-empty', predicate: (r) => r.title?.length > 0, severity: 'error' },
    { name: 'body-length', predicate: (r) => !r.body || r.body.length < 50000, severity: 'error' },
  ],
});
```

Each of these is just a pipeline concern with a participation record. They execute at their order position in the pipeline like any other handler. No special-case code paths in dispatch.

### 11. Pipeline routing tables for per-entity variation

Handler functions are shared across entities. When a pipeline concern needs per-entity routing (different storage targets, different schemas, different adapters per domain entity), it uses a **routing table** — a dedicated entity that maps domain entities to their specific configuration.

**Persist** is the canonical example. The core operation handlers (read, create, update, delete) need to know, for each domain entity: which table, which adapter (relational vs memory vs file), which schema columns. This can't live on the handler (that's shared) or the participation config (that's per-entity config for the adapter, not routing metadata). It lives on `persist_routing`:

```
persist_routing records:
  entity=note                table=note                adapter=relational  schema={...}  storage=Persistent()
  entity=venue               table=venue               adapter=relational  schema={...}  storage=Persistent()
  entity=rate_limit_records  table=rate_limit_records   adapter=memory      schema={...}  storage=Volatile()
```

The core handlers read from `persist_routing` to know where and how to store each entity's records. The routing table is a real entity — browseable, modifiable, observable. An agent can query it to understand the storage topology. A migration tool can read it to know which tables exist.

**Most pipeline concerns don't need routing tables.** Audit and observe write to `execution_log` ([04b](04b-append-storage-and-execution-log.md)). Emit writes to `emit_records`. The `handler` and `source` fields provide filtering. No routing needed.

**Any pipeline concern CAN have a routing table** when per-entity variation is needed. The pattern is always the same: a `{concern}_routing` entity with records mapping domain entities to concern-specific details. The routing table is optional per concern. Its schema is concern-specific. The handler knows to check for a routing table and fall back to defaults when absent.

This keeps the core tables uniform while giving pipeline concerns the ability to handle arbitrary per-entity complexity through a standard, discoverable mechanism.

### 12. Handler() as backend-resolved column type

Handler functions are referenced by string key via the `Handler()` column type on junction records (participation, subscription, binding). At runtime, the key resolves from a volatile function registry — a simple `Map<string, Function>`.

The framework seeds default handlers (pipeline concern adapters, CRUD handlers, transport adapters) into the registry at bootstrap. Consumers register custom handlers (action handlers, subscription handlers) via `participate()` and `subscribe()`. The registry is the single runtime lookup table for all executable behavior.

There is no separate execution entity, no hybrid storage, no persistent handler metadata. Pipeline placement (order, transactional) lives on the participation record. Handler identity is the string key. Handler discoverability comes from querying participation/subscription/binding records and their handler keys — the junction records ARE the registry of what's wired where.

### 13. Compilation is a filterable pipeline

Compilation reads from the core tables and produces dispatch-index records. Each read stage can be filtered to scope the compilation:

```
compile(filter?):
  1. Read graph-nodes         (filter: entity name, origin)
  2. Read participation        (filter: source entity, handler)
  3. Read subscriptions        (filter: source entity)
  4. Read bindings             (filter: source entity, handler)
  5. For each (initiator, entity, operation) triple in scope:
     → join initiator.participation ∪ entity.participation(operation)
     → sort, partition, freeze → dispatch-index record
  6. Assemble binding index from bindings
```

**Full compile** (build time): no filter, reads everything, produces complete dispatch-index. This is the bootstrap path.

**Entity-scoped recompile**: `{ entity: 'note' }` — reads all graph-nodes and initiators (stable), filters participation and subscriptions to note, rebuilds dispatch-index records for all (initiator, note, operation) triples. This is the hot path when an agent modifies note's participation.

**Initiator-scoped recompile**: `{ initiator: 'api-surface' }` — rebuilds dispatch-index records for all (api-surface, entity, operation) triples. This is the hot path when a surface's transport handlers change.

**Handler-scoped recompile**: `{ handler: 'audit-relational' }` — finds all entities that participate with that handler, rebuilds their dispatch-index entries across all initiators. This is the hot path when a handler is swapped (e.g. switching audit adapter).

The compilation logic is the same in all cases — the scope filter determines which records are read, and the join proceeds normally over the filtered set. This keeps compile simple (one code path) while supporting incremental recompilation at any granularity.

### 14. Cluster is a participate() concern, not a data field

In packages/next, cluster (read/write/action) lived on a separate record and filtered which pipeline stages applied at dispatch time. In the participation model, this filtering moves to declaration time: the `participate()` function generates participation records only for the operation types where each handler applies.

When `participate()` sees `audit: AuditFull`, it knows audit applies to write operations. It generates participation records that the pipeline assembler will include for create, update, delete, and transitions — but not for read. The participation records ARE the filter.

If a consumer wants audit on reads too, they specify that in `participate()`:

```ts
participate(note, {
  audit: { level: AuditFull, operations: '*' },  // all operations
  // vs
  audit: AuditFull,  // default: writes only
});
```

This removes cluster from the dispatch-time hot path. The `participate()` function handles the semantics of which handlers apply to which operation types.

### 15. Lifecycle transitions use the same pipeline

Lifecycle transitions (e.g. `note:publish`, `note:archive`) are writes. They go through the same participation records as `note:create` or `note:update`. The lifecycle declaration on the schema provides:

- **Validation**: the validate handler checks that the transition is legal (draft → published is allowed, draft → archived is not)
- **Route derivation**: creates named routes for each transition target

But from a pipeline perspective, a transition is a write operation. Same handlers, same ordering, same pipeline assembly. No special participation needed.

### 16. Presentation and binding: a third wiring domain

The participation model defines two wiring domains: pipeline (participation) and events (subscription). Presentation is a third wiring domain that connects entities to rendering with per-field metadata and agent interaction levels.

**Presentation is NOT a pipeline concern.** Pipeline participation records have order and transactional metadata (when/where in dispatch). Binding records have view label, component reference, field-level agent interaction levels, and rendering hints (how to render). Different schemas, different purpose.

#### binding — entity-to-component junction

The `binding` entity is the junction that connects a graph-node record to a rendering component, carrying per-entity rendering configuration — view label, direct component reference, field-level metadata with agent interaction levels, column selections, layout hints.

```
binding records:
  source → note    component=NoteDetail   view=detail
                   config={ fields: { title: { component: 'heading', agent: 'read-write' },
                                      body: { component: 'richtext', agent: 'read-write' },
                                      status: { component: 'badge', agent: 'read' } } }
  source → note    component=NoteList     view=list
                   config={ columns: ['title', 'status', 'author'],
                            fields: { title: { agent: 'read' }, status: { agent: 'read' } } }
  source → venue   component=VenueDetail  view=detail
                   config={ fields: { name: { component: 'heading', agent: 'read-write' },
                                      address: { component: 'map', agent: 'read' } } }
```

`source` is a Reference to a graph-node record. `component` is a direct TypeScript reference to a rendering function (a `.tsx` component), not a Handler() key — components run on the client, not the server. The binding record carries field-level agent interaction levels and rendering hints.

The `bind()` function creates binding records with direct component imports:

```ts
import { NoteDetail } from './components/NoteDetail';
import { NoteList } from './components/NoteList';

bind('note', [
  { component: NoteDetail, view: 'detail', config: {
    fields: {
      title: { component: 'heading', agent: 'read-write' },
      body: { component: 'richtext', agent: 'read-write' },
      status: { component: 'badge', agent: 'read' },
    },
  }},
  { component: NoteList, view: 'list', config: {
    columns: ['title', 'status', 'author'],
    fields: { title: { agent: 'read' }, status: { agent: 'read' } },
  }},
]);
```

At runtime, binding contexts provide signal-based state (`committed`/`current`/`dirty` per field) that both components and agents consume. See [10](10-presentation-and-binding.md) for the full binding model including `BindingContext`, `FieldState`, and agent interaction patterns.

**Projection dissolves.** Complex views requiring denormalized data, computed fields, or aggregations are handled as `Derived()` storage entities — the equivalent of SQL views. The binding layer stays trivial: entity fields → rendering components.

### 17. Three parallel wiring domains

The framework has three wiring domains. Each follows the same structural pattern — junction records connecting entities to infrastructure — applied to a different domain:

| Domain | What it wires | Resolution | Junction table | Consumer function |
|--------|--------------|------------|----------------|-------------------|
| **Pipeline** | How data flows through dispatch | Handler() key → function registry | `participation` | `participate()` |
| **Events** | What happens after/outside dispatch | Handler() key → function registry | `subscription` | `subscribe()` |
| **Presentation** | How data reaches rendering + agents | Direct component reference | `binding` | `bind()` |

Pipeline and event junctions share the Handler() runtime function registry — string keys that resolve to server-side functions. Binding junctions carry direct TypeScript component references instead, because components run on the client (Preact), not the server. The structural pattern is the same (junction record → executable behavior), but the resolution differs:

```
Pipeline:      participation.handler → registry → server function
Events:        subscription.handler → registry → server function
Presentation:  binding.component → direct TypeScript import → client component
```

The difference between the three domains is in the metadata each junction carries:
- **Participation** carries `operations` filter and `order` (pipeline placement)
- **Subscription** carries trigger type and failure policy (event/schedule wiring)
- **Binding** carries view label, field-level agent interaction levels, and rendering hints

#### Complete table inventory

| Table | Role | Type | Count |
|-------|------|------|-------|
| `graph_node` | Entity definitions | Reference | 1 |
| `participation` | Entity → handler junction (pipeline) | Junction | 1 |
| `subscription` | Entity → trigger → handler junction | Junction | 1 |
| `binding` | Entity → component junction (rendering) | Junction | 1 |
| `dispatch_index` | Frozen (initiator, entity, operation) → pipeline | Derived | 1 |
| `system` | Internal dispatch initiator | Initiator | 1 |
| Event log | `emit_records` | Persistent | 1 |
| Execution log | `execution_log` | Persistent + Append() | 1 |
| Discovery | `query_field`, `search_index` | Derived | 2 |
| Routing | `persist_routing` | Derived | 1 |
| Counters | `rate_limit_records` | Volatile | 1 |
| Session | `session` | Volatile | 1 |
| Real-time | `connection`, `client_subscription` | Volatile | 2 |
| Connector | `connector_binding` | Persistent | 1 |
| **Total infrastructure** | | | **~18 fixed** |

#### Complete consumer API

| Function | What it does | Table(s) |
|----------|-------------|----------|
| `define()` | Define data identity (schema + storage) | graph-node |
| `participate()` | Wire pipeline concerns (with defaults + inline actions) | participation |
| `subscribe()` | Wire event/schedule triggers | subscription |
| `bind()` | Wire presentation targets | binding |
| `compile()` | Build dispatch index + validate graph | reads all tables |

Each function targets a single primary table. `participate()` registers handler functions in the runtime registry as a side effect when inline actions are declared. `compile()` reads from all tables to produce the frozen dispatch index.

All four consumer functions produce records that flow into `compile()` as a flat list:

```ts
const registry = compile([
  define('note', { schema: {...}, storage: Persistent() }),
  define('venue', { schema: {...}, storage: Persistent() }),

  participate('note', {
    audit: AuditFull,
    policy: { rules: [...] },
    actions: {
      pin: { handler: pinHandler, kind: 'mutation', scoped: true },
      archive: { handler: archiveHandler, kind: 'mutation' },
    },
  }),
  participate('venue', { audit: AuditSummary, policy: { rules: [...] } }),

  subscribe('note', [
    { on: Created, handler: 'dispatch', config: { entity: 'feed', action: 'notify' } },
  ]),

  bind('note', [
    { component: NoteDetail, view: 'detail', config: {
      fields: { title: { component: 'heading', agent: 'read-write' }, body: { component: 'richtext', agent: 'read-write' } },
    }},
    { component: NoteList, view: 'list', config: {
      columns: ['title', 'status'],
      fields: { title: { agent: 'read' }, status: { agent: 'read' } },
    }},
  ]),
]);
```

### 18. Session entity tracks binding context

The `session` entity is a volatile per-user record that captures the user's current binding context — what they're focused on and what's available to them. The agent reads session + binding + graph-node records to understand the user's full context without special APIs.

```
session records (Volatile storage):
  userId=alice
  url=/notes/123
  latestBinding={ entity: 'note', id: '123', view: 'detail' }
  activeBindings=[
    { entity: 'note', id: '123', view: 'detail' },
    { entity: 'comment', filter: { noteId: '123' }, view: 'list' },
  ]
  lastActivity=2026-04-02T14:30:00Z
```

The session is updated on navigation — one lightweight write per page change. The frontend's router derives the active bindings from the URL + binding records and dispatches a session update through the normal pipeline. For a CLI, the `latestBinding` captures the most recent context even if it's not persistently "active" on screen.

The agent reads the session to build context:

```
Agent reads:
  session (alice)     → latest binding is note:123 in detail view
  binding (note)      → field config with agent interaction levels
  note:123            → current field values
  graph-node (note)   → available operations

Agent understands:
  "Alice is viewing note 123 in detail view. Title and body are editable.
   Status is read-only. She can publish, archive, or pin.
   There are comments below in a list view."
```

Real-time awareness uses subscriptions: the agent subscribes to session changes for a user and gets notified on navigation. One subscription, no polling.

### 19. Agent interaction levels on bindings

Binding config carries per-field agent interaction levels that declare what the agent can see and do on each rendering surface. These levels flow from the entity's classified schema (Public/Private/Sensitive) as defaults, with per-binding overrides.

Three interaction levels:

| Level | Agent can see value | Agent can modify | Use case |
|-------|-------------------|------------------|----------|
| **read-write** | Yes | Yes | Note title, document body, form fields |
| **read** | Yes | No | Status badges, computed fields, timestamps |
| **aware** | No (knows type + field name) | No | Credit card, SSN, passwords |

```
binding:
  source → note    handler → svelte-renderer   modality=visual  view=detail  component=DetailView
  config={
    fields: {
      title: { component: 'heading', agent: 'read-write' },
      body: { component: 'richtext', agent: 'read-write' },
      status: { component: 'badge', agent: 'read' },
    }
  }

binding:
  source → payment    handler → svelte-renderer   modality=visual  view=form  component=FormView
  config={
    fields: {
      amount: { component: 'currency', agent: 'read' },
      cardNumber: { component: 'masked-input', agent: 'aware' },
      billingAddress: { component: 'address', agent: 'read-write' },
    }
  }
```

**Default derivation from classified schema:**
- Public fields → `read-write`
- Private fields → `read`
- Sensitive fields → `aware`

The binding config overrides these defaults per-view. A field might be `read-write` in the detail view but `read` in the list view.

The `aware` level is critical for agent trust. The agent is never confused about what's on screen — it knows every field that exists and its type. It just has boundaries around value access. This lets the agent say: "I see you're on the payment form. I can help with the billing address but you'll need to enter the card details yourself."

### 20. Agent as session participant (forward-looking)

The session model enables the agent to be an active participant, not just an observer. This section captures the architectural direction; implementation is future work.

**Agent sessions.** The agent has its own session record, identical in structure to a user session. When focused on the same entity as a user, both sessions are visible:

```
session records:
  userId=alice       latestBinding={ entity: 'note', id: '123', view: 'detail' }
  userId=agent-1     latestBinding={ entity: 'note', id: '123', view: 'detail' }
```

Two sessions on the same record. The Svelte component renders both presences.

**Cursor state.** Sessions can carry cursor position for collaborative editing:

```
session:
  userId=agent-1
  latestBinding={
    entity: 'note', id: '123', view: 'detail',
    cursor: { field: 'body', position: 342, selection: [342, 387] },
  }
```

The component renders the agent's cursor. Real-time sync through stream subscriptions on the session entity. The framework provides the session infrastructure; the collaborative editing protocol (CRDT/OT) is a component concern.

**Agent-driven content.** The agent proposes or makes changes through normal dispatch:

- `dispatch('note', 'update', { id: '123', body: '...' })` — direct edit
- `dispatch('note', 'suggest', { id: '123', field: 'body', suggestion: '...' })` — proposed edit (action)

Both go through the participation pipeline (validate, update/create, emit, audit). The user sees changes attributed to the agent.

**Dynamic UI composition (exploration).** Two models for agent-driven document building:

1. **Template model**: A fixed layout with sections. The agent fills/modifies each section through read-write bindings. Less dynamic, fewer choices, one fewer interaction level. The binding config defines the template; the agent writes content into it.

2. **Slot model**: A blank page with component slots. The agent dynamically adds/removes/reorders components. More expressive — the agent could generate a decision document by progressively adding sections as it gathers information. This would require a new agent interaction level beyond read-write — something like `compose` — where the agent can modify the structure of the view, not just the content of fields.

The template model works with the current binding design. The slot model would require the binding config (or a related entity) to support dynamic component lists that the agent can modify at runtime. Whether this warrants a fourth interaction level (`compose`) or can be modeled as agent writes to a "layout" field on the entity is an open design question.

### 21. Dispatch index is a Derived entity

The dispatch index — the frozen lookup table that maps `(initiator, entity, operation)` to a pre-assembled pipeline — is itself an entity with Derived() storage. It is the materialized output of `compile()`.

```
graph-node:
  name=dispatch-index   origin=framework   storage=Derived()

dispatch-index records:
  initiator=api-surface   entity=note   operation=create   pipeline=[...frozen stages...]
  initiator=api-surface   entity=note   operation=read     pipeline=[...frozen stages...]
  initiator=api-surface   entity=venue  operation=read     pipeline=[...frozen stages...]
  initiator=system        entity=note   operation=create   pipeline=[...frozen stages...]
  initiator=system        entity=feed   operation=notify   pipeline=[...frozen stages...]
```

Making the dispatch index an entity rather than a hidden data structure has several consequences:

- **Browseable.** An agent can discover all available `(initiator, entity, operation)` combinations and see what pipeline each one runs. "What happens when api-surface dispatches note:create?" is a query against the dispatch-index entity.
- **Observable.** Recompilation produces new records, which can be diffed, audited, or subscribed to.
- **Consistent with the principle.** If it holds structured, important data that's useful to discover, it's an entity.
- **Derived() storage.** The records are computed by compile, not directly written. Recompilation recomputes the derived records from the source tables (graph-node, participation).

The full compilation output is: for each initiator, for each entity reachable through that initiator, for each operation on that entity → join participations → sort → partition → freeze as a dispatch-index record.

At runtime, dispatch is a lookup: `dispatch-index[initiator][entity][operation]` → frozen `TransactionPipeline`. No graph walking, no joining, no sorting on the hot path.

## Open Questions

### Schema for the core tables

The four core tables (graph-node, participation, subscription, binding) plus the derived dispatch-index need concrete schemas during implementation. This ADR specifies the conceptual model; detailed schemas should be specified in a follow-up document or during initial implementation.

### Dynamic UI composition

The slot model for agent-driven UI (Decision 20) raises questions about whether `compose` should be a fourth interaction level, whether layout is a field on the entity or a separate concern, and how component ordering/insertion works in the binding model. This intersects with the decision application use case: an agent progressively building a document through a guided process, dynamically generating sections as information is gathered. Deferred to implementation-level ADRs.

## Resolved Questions

### Presentation routing for complex views (resolved)

Complex views requiring denormalized data, computed fields, or aggregations are handled on the entity side, not the presentation side. These are Derived() storage entities — the equivalent of SQL views. A Derived entity computes its records from other entities' data (joins across relations, aggregations, projections). Once the derived entity exists, binding it to a rendering handler works identically to binding any other entity — same `bind()` function, same binding records, same pattern.

This means `presentation:routing` is not needed as a separate mechanism. The complexity lives in the Derived entity's computation logic (entity/storage concern), not in the binding layer. The binding layer stays trivial: entity fields → rendering components.

### Modality-specific transport concerns (resolved → implementation)

The initiator model (Decision 9) establishes the architectural pattern. The remaining work — designing specific agent-surface handler adapters, integrating with AI model APIs, defining how voice/text modality is configured per-session — is implementation-level design specified in follow-up ADRs, not an open architectural question in this ADR.

## Implementation Sub-ADRs

The implementation is specified in 22 sub-ADRs, organized in dependency order:

### Phase A: Foundation (compile-time)

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [00](00-vocabulary.md) | Vocabulary | — | Import boundary, Operation (4 literals), EventDescriptor (4 kinds), new types (Origin, AgentInteractionLevel, ActionKind, FailurePolicy), Append() storage strategy, removals |
| [01](01-core-records-and-define.md) | Core Records and define() | 00 | GraphNodeRecord, define(), deriveOperations(), DeclarationRecord union |
| [01b](01b-record-metadata-ownership-scoping.md) | Record Metadata, Ownership & Data Scoping | 01 | Framework-managed columns (createdAt/By, updatedAt/By, ownerId, version, deletedAt), `owned: true` on DefineConfig, read scoping, soft delete, optimistic concurrency |
| [01c](01c-query-field-and-search.md) | Query Field & Search | 01b, 04 | `query_field` Derived entity (strongly typed per-field records), operator sets per semantic type, search dimension model (searchable + indexed + framework columns), cross-entity `search_index`, agent discoverability of read/write params |
| [01d](01d-wiring-effects-cross-entity-lifecycle.md) | Wiring Effects & Cross-Entity Lifecycle | 01, 03, 04 | Effect rules on Relation/Reference (deleted, transitioned), reverse wiring index in CompileResult, core handler cascade/restrict/nullify, re-entrant dispatch for propagation |
| [02](02-wiring-functions.md) | Wiring Functions | 01 | Handler() column type, ParticipationRecord (with order + transactional), participate() with implicit defaults and inline actions |
| [03](03-compile-and-dispatch-index.md) | Compile and Dispatch Index | 01, 02 | compile(), DispatchIndexRecord, initiator join, partition rule, filterable recompilation |

### Phase B: Runtime (dispatch)

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [04](04-store-adapters-and-crud.md) | Store Adapters and CRUD | 01, 02, 03 | EntityStore (read parameterized), CRUD handlers, persist_routing, 5 adapters (relational, memory, file, derived, virtual) |
| [04b](04b-append-storage-and-execution-log.md) | Append Storage & Execution Log | 01, 04, 01b | Append() storage strategy, indexed-append adapter, `execution_log` entity (consolidates 9 output entities), file rotation, per-execution retention, dead-letter as status value |
| [04c](04c-schema-reconciliation.md) | Schema Reconciliation & Evolution | 01, 01b, 04, 04b | Schema diffing, change classification (safe/cautious/destructive/ambiguous), auto-apply policy, `evolve` config on define(), `_janus_schema` tracking, lifecycle state evolution, production migration workflow |
| [05](05-pipeline-concern-adapters.md) | Pipeline Concern Adapters | 01, 02, 04, 04b | ConcernContext, all 10 pipeline concern adapters, output to `emit_records` + `execution_log` + `rate_limit_records` |
| [06](06-dispatch-runtime.md) | Dispatch Runtime | 03, 04, 05 | createDispatchRuntime(), DispatchResponse, pipeline execution, re-entrant dispatch |

### Phase C: Async

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [07](07-subscriptions-broker-scheduler.md) | Subscriptions, Broker, Scheduler | 01, 02, 05, 06 | SubscriptionRecord, subscribe(), broker, scheduler, subscription adapters |
| [07b](07b-tracked-subscriptions-dead-letter.md) | Tracked Subscriptions & Background Work | 07, 04b | `tracked` flag on subscriptions, retry with backoff, status progression in `execution_log`, dead-letter as status='dead', connector/job composition patterns |
| [07c](07c-connectors.md) | Connectors | 07b | Connector as entity pattern, `connector_binding` entity, connector-distribute adapter, ingest/distribute patterns, merge semantics, checkpoint/resume |

### Phase D: Surfaces

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [08](08-http-surface-and-bootstrap.md) | HTTP Surface and App Bootstrap | 01–07 | api-surface, HTTP handler adapters, createApp(), route derivation |
| [08b](08b-assets-and-media.md) | Assets & Media | 01, 04, 08 | `asset` entity, asset storage backends, upload as transport concern, URL resolution on reads, asset field validation |
| [09](09-agent-surface-and-session.md) | Agent Surface and Session | 01–08, 10 | agent-surface, session entity, interaction levels, modality, tool discovery |

### Phase E: Presentation

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [10](10-presentation-and-binding.md) | Presentation and Binding | 01, 02, 09 | BindingRecord (component reference + field metadata + agent interaction levels), bind(), BindingContext/FieldState (signals), binding index |

### Phase F: Client

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [12a](12a-connection-protocol-and-sync.md) | Connection Protocol & Sync | 01, 04b, 07, 08, 09 | `connection` + `client_subscription` Volatile entities, SSE/WebSocket establishment, sync protocol (entity events, client subscriptions, session navigation), stream-pusher routing, heartbeat, reconnection |
| [12b](12b-client-entity-cache.md) | Client Entity Cache | 12a, 01c, 10 | `@janus-next/client` package, normalized entity cache, binding-driven rendering, query capability loading, optimistic dispatch, SvelteKit integration |

### Phase G: Integration

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [11](11-testing-harness.md) | Testing Harness and Proof Entities | 01–12 | createTestHarness(), proof entities, createProofHarness(), integration scenarios |
| [13](13-external-agent-integration.md) | External Agent Harness Integration | 08, 09 | CLI bridge, HTTP/MCP integration surfaces, external agent identity, boundary rules (code vs API), dogfooding pattern |

### Phase H: Domain

| ADR | Title | Depends on | Scope |
|-----|-------|-----------|-------|
| [15](15-calendar-domain-entities.md) | Calendar Domain Entities | 01, 02, 05, 07c, 08 | calendar/recurrence_rule/availability_set/calendar_subscription entities, calendar participation config, time-windowed reads, iCal feed derivation |

### Remaining gaps (identified, not yet specified)

The following capabilities were identified during V1 gap analysis as needing sub-ADRs. They are listed here for tracking but do not yet have documents:

| Gap | Priority | Notes |
|-----|----------|-------|
| ~~Assets / media management~~ | ~~High~~ | Specified in [08b](08b-assets-and-media.md) |
| ~~Real-time protocol (SSE/WebSocket)~~ | ~~High~~ | Specified in [12a](12a-connection-protocol-and-sync.md) |
| ~~Client entity cache~~ | ~~High~~ | Specified in [12b](12b-client-entity-cache.md) |
| ~~Modality negotiation~~ | ~~Medium~~ | Resolved: each surface's respond execution determines output shape. The agent surface uses voice bindings from the binding index to shape tool responses ([09](09-agent-surface-and-session.md)). No cross-surface modality negotiation needed — the surface IS the modality. |
| Templates (notification rendering) | Medium — builds on subscriptions | How notify-sender renders content. Deferred until subscription adapters are implemented. |
| ~~Schema migration / evolution~~ | ~~Medium~~ | Specified in [04c](04c-schema-reconciliation.md) |

## Implications

This ADR does not modify packages/next. It specifies the architecture for a new implementation in `packages/` that will replace the current entity/steps/pipeline layering while preserving the proven pieces: vocabulary types, storage strategies, route derivation from storage, the compile-then-freeze model, and TransactionPipeline as the runtime execution shape.
