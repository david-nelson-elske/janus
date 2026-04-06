# 124-03: Compile and Dispatch Index

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [02](02-wiring-functions.md) (Wiring Functions)

## Scope

This sub-ADR specifies:
- `compile()` — pure function from `DeclarationRecord[]` to `CompileResult`
- `DispatchIndexRecord` — the frozen (initiator, entity, operation) → pipeline mapping
- The initiator join formula and its implementation
- The partition rule (preTx/tx/postTx from transactional flag)
- `FrozenPipeline` — the `TransactionPipeline` shape carried forward
- `system` as the framework initiator entity
- Initiator resolution and surface handling
- Filterable recompilation (entity-scoped, initiator-scoped, concern-scoped)
- `persist_routing` record generation
- Validation: duplicate names, missing references, wiring integrity

This sub-ADR does NOT cover:
- Runtime dispatch execution ([06](06-dispatch-runtime.md))
- Concern adapter implementations ([05](05-pipeline-concern-adapters.md))
- Store adapter wiring ([04](04-store-adapters-and-crud.md))
- Subscription index assembly ([07](07-subscriptions-broker-scheduler.md))
- Binding index assembly ([10](10-presentation-and-binding.md))

## compile()

The single compilation entry point. A pure function — no side effects, no IO, deterministic output from input:

```ts
function compile(
  declarations: readonly DeclarationRecord[],
  initiators?: readonly InitiatorConfig[],
  filter?: CompileFilter,
): CompileResult
```

### Input: DeclarationRecord[]

A flat list of tagged records produced by the four consumer functions. `compile()` routes each by its `kind` tag:

| `kind` | Target table | Source function |
|--------|-------------|----------------|
| `'define'` | graph-node | `define()` |
| `'participate'` | participation | `participate()` |
| `'subscribe'` | subscription | `subscribe()` |
| `'bind'` | binding | `bind()` |

### Input: InitiatorConfig[]

Initiator definitions for surfaces. `system` is always included as a framework initiator. Consumer surfaces are passed explicitly:

```ts
interface InitiatorConfig {
  readonly name: string;
  readonly origin: Origin;
  readonly participations: readonly ParticipationRecord[];
}
```

If `initiators` is omitted, only `system` is used (no surfaces). This is the common path for tests.

### Input: CompileFilter

Optional filter for scoped recompilation:

```ts
interface CompileFilter {
  readonly entity?: string;
  readonly initiator?: string;
  readonly handler?: string;
}
```

When a filter is provided, compile reads all stable data (graph-nodes, participations) but only processes the filtered subset when building dispatch-index records.

## CompileResult

```ts
interface CompileResult {
  // Core table indexes
  readonly graphNodes: ReadonlyMap<string, GraphNodeRecord>;
  readonly participations: readonly ParticipationRecord[];
  readonly subscriptions: readonly SubscriptionRecord[];
  readonly bindings: readonly BindingRecord[];

  // Dispatch
  readonly dispatchIndex: ReadonlyMap<string, FrozenPipeline>;  // key: 'initiator:entity:operation'
  readonly initiators: ReadonlyMap<string, InitiatorConfig>;

  // Routing
  readonly persistRouting: readonly RoutingRecord[];

  // Wiring
  readonly wiring: WiringIndex;

  // Metadata
  readonly compiledAt: string;
  readonly compilationDuration: number;

  // Query helpers
  pipeline(initiator: string, entity: string, operation: Operation): FrozenPipeline | undefined;
  entity(name: string): GraphNodeRecord | undefined;
  participationsFor(entity: string): readonly ParticipationRecord[];
  operationsFor(entity: string): readonly Operation[];
}
```

The `pipeline()` helper is the primary runtime lookup — it returns the frozen pipeline for a given (initiator, entity, operation) triple.

## FrozenPipeline

The runtime execution shape, carried forward from packages/next's `TransactionPipeline`:

```ts
interface FrozenPipeline {
  readonly preTx: readonly PipelineStage[];
  readonly tx: readonly PipelineStage[];
  readonly postTx: readonly PipelineStage[];
  readonly needsTx: boolean;
}

type PipelineStage = (ctx: ConcernContext) => Promise<void>;
```

Each `PipelineStage` is a closure produced during compilation that captures:
1. The handler function (resolved from the Handler() backend via the participation record's key)
2. The participation config (the per-entity config for this handler)
3. Any handler-level metadata needed at runtime

## The initiator join

The core algorithm for assembling a pipeline. For a given (initiator, entity, operation) triple:

```
pipeline(initiator, entity, operation) =
  sort(initiator.participations ∪ entity.participations(operation))
```

### Algorithm

```
assembleDispatchIndex(graphNodes, participations, handlerBackend, initiators):

  for each initiator I in initiators:
    initiatorParts = participations where source = I.name

    for each entity E in graphNodes:
      for each operation O in E.operations:
        // 1. Collect entity participations for this operation
        entityParts = participations
          where source = E.name
          AND (operations is undefined OR operations includes O)

        // 2. Union with initiator participations
        allParts = initiatorParts ∪ entityParts

        // 3. Resolve Handler() keys to functions
        stages = allParts.map(p => {
          fn = handlerBackend.resolve(p.handler)  // hard error if unresolved
          return { order: p.order, transactional: p.transactional, handler: fn, config: p.config }
        })

        // 4. Sort by order
        stages.sort((a, b) => a.order - b.order)

        // 5. Partition
        pipeline = partition(stages)

        // 6. Freeze and store
        key = `${I.name}:${E.name}:${O}`
        dispatchIndex.set(key, Object.freeze(pipeline))
```

### Partition rule

The `transactional` flag cleanly partitions the sorted stage list:

1. **Scan** the sorted list. Find the first stage with `transactional: true`. Call its position `txStart`.
2. **preTx**: all stages before `txStart` (must have `transactional: false`).
3. **tx**: all stages from `txStart` through the last stage with `transactional: true`.
4. **postTx**: all remaining stages after the last transactional stage (must have `transactional: false`).
5. **needsTx**: `tx.length > 0`.

For read operations: no stages are transactional (`read` has `transactional: false`), so `preTx` = everything, `tx` = empty, `postTx` = empty, `needsTx = false`.

For write operations: the core handler (create/update/delete) + emit + audit are transactional. Policy, parse, validate, invariant are preTx. Observe, respond, transport respond are postTx.

**Invariant:** No non-transactional stage may appear between two transactional stages. If this occurs, it is a compilation error. This ensures the tx group is contiguous.

### Example: api-surface dispatching note:create

```
Initiator participations (api-surface):
  http-receive    → order=5,  transactional=false
  http-identity   → order=6,  transactional=false
  http-respond    → order=80, transactional=false

Entity participations (note, filtered to 'create'):
  policy          → order=10, transactional=false
  parse           → order=20, transactional=false
  validate        → order=25, transactional=false
  invariant       → order=26, transactional=false
  create          → order=35, transactional=true
  emit            → order=40, transactional=true
  audit           → order=50, transactional=true
  observe         → order=50, transactional=false
  respond         → order=70, transactional=false

Sorted union:
  http-receive(5), http-identity(6), policy(10), parse(20),
  validate(25), invariant(26), create(35), emit(40), audit(50),
  observe(50), respond(70), http-respond(80)

Partitioned:
  preTx:   http-receive, http-identity, policy, parse, validate, invariant
  tx:      create, emit, audit
  postTx:  observe, respond, http-respond
  needsTx: true
```

### Example: system dispatching note:read

```
System has no participations.

Entity participations (note, filtered to 'read'):
  policy          → order=10, transactional=false
  read            → order=35, transactional=false
  respond         → order=70, transactional=false

Partitioned:
  preTx:   policy, read, respond   (no tx stages → everything in preTx)
  tx:      (empty)
  postTx:  (empty)
  needsTx: false
```

## system initiator

The `system` initiator is a framework-provided entity with no participation records by default:

```ts
const systemInitiator: InitiatorConfig = {
  name: 'system',
  origin: 'framework',
  participations: [],
};
```

It is always included in compilation. The join with `system` produces pipelines containing only the entity's own concern stages — no transport wrapping.

System participation records can be added if needed (e.g., a system-identity concern that sets the actor to an elevated system principal):

```ts
compile(declarations, [
  { name: 'system', origin: 'framework', participations: [
    { source: 'system', handler: 'system-identity', order: 6, transactional: false, config: {} },
  ]},
  apiSurface,
]);
```

## persist_routing generation

During compilation, `compile()` generates `persist_routing` records from graph-node records:

```ts
interface RoutingRecord {
  readonly entity: string;
  readonly table: string;
  readonly adapter: 'relational' | 'memory' | 'file' | 'derived' | 'virtual';
  readonly schema: Readonly<Record<string, unknown>>;
  readonly storage: StorageStrategy;
}
```

The adapter is derived from the storage strategy:

| Storage | Adapter |
|---------|---------|
| `Persistent()` | `'relational'` |
| `Singleton()` | `'relational'` (with memory cache) |
| `Volatile()` | `'memory'` |
| `Derived()` | `'derived'` |
| `Virtual()` | `'virtual'` |

CRUD handlers ([04](04-store-adapters-and-crud.md)) read from `persistRouting` to resolve the correct store adapter for each entity.

## Validation

`compile()` performs the following validation during assembly:

| Check | Error |
|-------|-------|
| Duplicate entity names | `DuplicateEntityError` |
| Participation references unknown entity | `UnknownEntityError` |
| Participation has unresolved Handler() key | `UnresolvedHandlerError` |
| Non-transactional stage between two transactional stages | `NonContiguousTransactionError` |
| Wiring target (Relation/Reference) points to undefined entity | `UnknownWiringTargetError` |
| Participation for operation not in entity's operation set | `InvalidOperationError` |

Validation runs after all records are collected and before dispatch-index assembly.

## Filterable recompilation

The same `compile()` function supports scoped recompilation through the `filter` parameter:

| Filter | Behavior |
|--------|----------|
| `{ entity: 'note' }` | Rebuilds dispatch-index records for all (initiator, note, operation) triples. |
| `{ initiator: 'api-surface' }` | Rebuilds dispatch-index records for all (api-surface, entity, operation) triples. |
| `{ handler: 'audit-relational' }` | Finds all entities participating with this handler, rebuilds their dispatch-index entries across all initiators. |
| `{ entity: 'note', handler: 'audit-relational' }` | Most targeted: rebuilds only note's entries that involve audit. |

In all cases, the core tables (graphNodes, executions) are read in full — they are stable. The filter scopes which (initiator, entity, operation) triples are recomputed. Existing dispatch-index entries outside the filter scope are preserved.

## Dispatch index as a Derived entity

The dispatch-index is conceptually a Derived() storage entity:

```
graph-node:
  name=dispatch-index   origin=framework   storage=Derived()
```

Its records are the `DispatchIndexRecord` values:

```ts
interface DispatchIndexRecord {
  readonly initiator: string;
  readonly entity: string;
  readonly operation: Operation;
  readonly pipeline: FrozenPipeline;
}
```

In practice, the dispatch-index lives in memory as a `ReadonlyMap` on the `CompileResult`. It is not persisted to a store table. The "Derived entity" framing means:
- It is browseable — agents can query the compile result for available pipelines
- It is recomputable — same compile logic, same inputs, same outputs
- It participates in the "everything is an entity" principle conceptually

## Testing gate

When 124-03 is implemented, the following should be testable:

- `compile([define('note', ...), participate('note', {})])` produces dispatch-index entries for (system, note, read/create/update/delete)
- Adding a surface initiator produces entries for (surface, note, read/create/update/delete)
- Pipeline order is correct: transport(5-6) → policy(10) → parse(20) → validate(25) → core(35) → emit(40) → audit(50) → respond(70) → transport-respond(80)
- Read pipeline has `needsTx: false`; create/update/delete have `needsTx: true`
- Derived entity only produces `read` entries
- Singleton entity produces `read` and `update` entries
- `system` initiator produces pipelines without transport handlers
- Surface initiator produces pipelines WITH transport handlers
- `compile()` with filter `{ entity: 'note' }` only rebuilds note's dispatch-index entries
- Validation catches duplicate entity names
- Validation catches participation with unresolved Handler() key
- Validation catches non-contiguous transaction groups
- `persistRouting` records are generated with correct adapter per storage strategy
- `CompileResult.pipeline('system', 'note', 'create')` returns the frozen pipeline
- All returned data is frozen
