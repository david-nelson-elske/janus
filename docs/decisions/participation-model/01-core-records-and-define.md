# 124-01: Core Records and define()

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [00](00-vocabulary.md) (Vocabulary)
**Vocabulary:** All typed constructors referenced here are imported from `@janus/vocabulary`. The simplified `Operation` and `EventDescriptor` types are defined in [00](00-vocabulary.md).

## Scope

This sub-ADR specifies:
- The `GraphNodeRecord` type — the entity definition record shape
- The `Origin` type replacing `realm` and `kind`
- The `Operation` type — four CRUD operations replacing the nine-kind discriminated union
- The `define()` function — pure, returns an immutable tagged record
- `deriveOperations()` — how the operation set is determined from schema + storage
- The `DeclarationRecord` discriminated union — the input shape for `compile()`

This sub-ADR does NOT cover:
- Participation records or Handler() registration ([02](02-wiring-functions.md))
- Compilation or dispatch index ([03](03-compile-and-dispatch-index.md))
- Store adapters ([04](04-store-adapters-and-crud.md))
- Runtime dispatch ([06](06-dispatch-runtime.md))

## Operation and Origin

The `Operation` type (4 string literals) and `Origin` type (framework | consumer) are defined in [00](00-vocabulary.md). This sub-ADR uses them without re-specifying.

**Lifecycle transitions** remain part of the model but are not a separate operation kind. A transition is an `update` where the input includes a lifecycle field change. The validate concern (order=25) checks that the transition is legal according to the lifecycle's transition map. Route derivation still produces named routes for each transition target (e.g., `note:publish`, `note:archive`), but the underlying operation is `update`.

**Custom actions** (e.g., `note:pin`) are declared inline via the `actions` key on `participate()`. The handler is registered in the Handler() backend and a participation record is created at order=35. They are dispatched by their action name, and the pipeline treats them like any other core-order handler. See [02](02-wiring-functions.md).

## GraphNodeRecord

Every `define()` call produces a `GraphNodeRecord` — the entity's definition record in the `graph-node` table:

```ts
interface GraphNodeRecord {
  readonly name: string;
  readonly origin: Origin;
  readonly schema: Readonly<Record<string, SchemaField>>;
  readonly classifiedSchema: ClassifiedSchema;
  readonly storage: StorageStrategy;
  readonly description?: string;
  readonly sensitivity: Sensitivity;
  readonly lifecycles: readonly LifecycleEntry[];
  readonly wiringFields: readonly WiringFieldEntry[];
  readonly operations: readonly Operation[];
  readonly transitionTargets: readonly TransitionTarget[];
}
```

| Field | Source | Description |
|-------|--------|-------------|
| `name` | First argument to `define()` | Unique entity name. Must be non-empty, lowercase, alphanumeric + underscores. Directly usable as SQL table name. |
| `origin` | `'consumer'` for `define()` calls; `'framework'` for framework-seeded entities | Who owns this entity definition. |
| `schema` | Config input | The raw schema fields — semantic types, wiring types, lifecycle fields. |
| `classifiedSchema` | Derived from schema | Schema with each field classified as Public, Private, or Sensitive. Carried forward from packages/next. |
| `storage` | Config input | Storage strategy: Persistent(), Singleton(), Volatile(), Derived(), Virtual(). |
| `description` | Config input (optional) | Human-readable description for discovery. |
| `sensitivity` | Derived from classifiedSchema | Highest sensitivity level across all fields. |
| `lifecycles` | Scanned from schema | Array of `{ field, lifecycle }` entries for each Lifecycle() field in the schema. |
| `wiringFields` | Scanned from schema | Array of `{ field, wiring }` entries for each Relation/Reference/Mention field. |
| `operations` | Derived from storage + schema | Which CRUD operations this entity supports. See `deriveOperations()`. |
| `transitionTargets` | Derived from lifecycles | Named transition targets (e.g., `{ field: 'status', from: 'draft', to: 'published', name: 'publish' }`). |

### LifecycleEntry and WiringFieldEntry

```ts
interface LifecycleEntry {
  readonly field: string;
  readonly lifecycle: LifecycleDescriptor;
}

interface WiringFieldEntry {
  readonly field: string;
  readonly wiring: WiringType; // RelationField | ReferenceField | MentionField
}

interface TransitionTarget {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly name: string; // e.g., 'publish', 'archive'
}
```

### ClassifiedSchema (carried forward)

The `ClassifiedSchema` type from `@janus/vocabulary` is used unchanged. Each field in the schema is classified as `Public`, `Private`, or `Sensitive` based on the semantic type's default or explicit classification. This drives agent interaction level defaults (see [09](09-agent-surface-and-session.md)).

## deriveOperations()

The operation set for an entity is derived from its storage strategy and schema:

```ts
function deriveOperations(
  storage: StorageStrategy,
  lifecycles: readonly LifecycleEntry[],
): readonly Operation[]
```

| Storage strategy | Operations | Rationale |
|-----------------|------------|-----------|
| `Persistent()` | `['read', 'create', 'update', 'delete']` | Full CRUD |
| `Singleton()` | `['read', 'update']` | One record, read or update. No create (auto-seeded) or delete. |
| `Volatile()` | `['read', 'create', 'update', 'delete']` | Full CRUD (in-memory) |
| `Derived()` | `['read']` | Read-only — computed from other entities |
| `Virtual()` | `['read']` | Read-only — proxied from external system. Virtual entities with write support are modeled as custom actions. |

Lifecycle transitions do not add to the operation set — they are `update` operations. The `transitionTargets` on the GraphNodeRecord provide named routes for each legal transition, but the underlying operation is `update`.

## define()

The `define()` function is the entry point for entity definition. It is a pure function that returns a frozen tagged record:

```ts
function define(name: string, config: DefineConfig): DefineResult
```

### DefineConfig

```ts
interface DefineConfig {
  readonly schema: Record<string, SchemaField>;
  readonly storage: StorageStrategy;
  readonly description?: string;
}
```

This is dramatically simpler than packages/next's `EntityConfig`, which mixed definition with step configuration (inbound/execution/outbound blocks). In the participation model, `define()` only captures identity — schema + storage. Pipeline wiring is handled by `participate()` ([02](02-wiring-functions.md)).

### SchemaField

A `SchemaField` is any value produced by the vocabulary constructors:

```ts
type SchemaField =
  | SemanticField     // Str(), Int(), DateTime(), etc.
  | WiringType        // Relation(), Reference(), Mention()
  | LifecycleDescriptor  // Lifecycle()
  ;
```

### DefineResult

```ts
interface DefineResult {
  readonly kind: 'define';
  readonly record: GraphNodeRecord;
}
```

`DefineResult` is one variant of the `DeclarationRecord` discriminated union (see below). The `kind: 'define'` tag allows `compile()` to route each declaration to the correct table.

### Behavior

1. **Schema scanning.** `define()` scans the schema for lifecycle fields and wiring fields, producing the `lifecycles` and `wiringFields` arrays.
2. **Classification.** Each schema field is classified (Public/Private/Sensitive) to produce `classifiedSchema`. The entity's overall `sensitivity` is the highest classification.
3. **Operation derivation.** `deriveOperations(storage, lifecycles)` produces the operation set.
4. **Transition targets.** For each lifecycle field, each legal transition in the transition map produces a `TransitionTarget` with a derived name (the target state, e.g., `'publish'` for draft→published).
5. **Freezing.** The returned `DefineResult` and its `GraphNodeRecord` are deeply frozen (Object.freeze). No mutation after creation.
6. **No side effects.** `define()` does not register anything globally. The result flows into `compile()` as part of a flat declaration list.

### Example

```ts
import { define } from '@janus/entity';
import { Str, Markdown, Relation, Lifecycle, Persistent } from '@janus/vocabulary';

const note = define('note', {
  schema: {
    title: Str({ required: true }),
    body: Markdown(),
    author: Relation('user'),
    status: Lifecycle({
      states: ['draft', 'published', 'archived'],
      initial: 'draft',
      transitions: { draft: ['published'], published: ['archived'] },
    }),
  },
  storage: Persistent(),
});

// note.record.operations → ['read', 'create', 'update', 'delete']
// note.record.lifecycles → [{ field: 'status', lifecycle: { states: [...], ... } }]
// note.record.wiringFields → [{ field: 'author', wiring: { kind: 'relation', ... } }]
// note.record.transitionTargets → [
//   { field: 'status', from: 'draft', to: 'published', name: 'publish' },
//   { field: 'status', from: 'published', to: 'archived', name: 'archive' },
// ]
```

## DeclarationRecord

All consumer functions (`define()`, `participate()`, `subscribe()`, `bind()`) return tagged records that flow into `compile()` as a flat list. The discriminated union:

```ts
type DeclarationRecord =
  | DefineResult          // kind: 'define'      — from define()
  | ParticipateResult     // kind: 'participate'  — from participate()
  | SubscribeResult       // kind: 'subscribe'    — from subscribe()
  | BindResult            // kind: 'bind'         — from bind()
  ;
```

Each variant is specified in its respective sub-ADR. `compile()` ([03](03-compile-and-dispatch-index.md)) accepts `readonly DeclarationRecord[]` and routes each record to the appropriate table by its `kind` tag. Inline action handlers are registered in the Handler() backend by `participate()` as a side effect.

### Usage pattern

```ts
const registry = compile([
  // Definitions
  define('note', { schema: {...}, storage: Persistent() }),
  define('venue', { schema: {...}, storage: Persistent() }),
  define('config', { schema: {...}, storage: Singleton() }),

  // Participation — defaults included automatically (see 02)
  participate('note', {
    audit: AuditFull,
    policy: { rules: [...] },
    actions: { pin: { handler: pinHandler, kind: 'mutation', scoped: true } },
  }),
  participate('venue', { audit: AuditSummary }),

  // Subscriptions (see 07)
  subscribe('note', [{ on: Created, handler: 'dispatch-adapter', config: { entity: 'feed', action: 'notify' } }]),

  // Bindings — preset functions provide rendering metadata (see 10)
  bind('note', [{ component: NoteDetail, view: 'detail', config: { fields: { title: { component: 'heading', agent: 'read-write' } } } }]),
]);
```

## What carries forward from packages/next

| Concept | Status | Notes |
|---------|--------|-------|
| Semantic types (22 + 4 compound) | Unchanged | Imported from `@janus/vocabulary` |
| Wiring types (Relation, Reference, Mention) | Unchanged | Imported |
| Classifications (Public, Private, Sensitive) | Unchanged | Imported |
| Storage strategies (Persistent, Singleton, Volatile, Derived, Virtual) | Unchanged | Imported |
| Lifecycle constructors | Unchanged | Imported |
| Event descriptors | Unchanged | Imported (used by participate, subscribe) |
| Schema scanning (lifecycles, wiring fields) | Logic carried forward | Reimplemented against GraphNodeRecord |
| Classification scanning | Logic carried forward | Same algorithm, new record shape |
| Route derivation from storage | Simplified | `deriveOperations()` replaces the larger route derivation |

| Concept | Status | Notes |
|---------|--------|-------|
| `EntityHandle` class | Replaced | `GraphNodeRecord` is a frozen plain object, not a class |
| `EntityConfig` with inbound/execution/outbound | Replaced | `DefineConfig` has only schema + storage + description |
| `realm` (domain/framework/operational) | Replaced | `origin` (framework/consumer) |
| `kind` (server/transport/client) | Removed | Determined by participation records |
| `Operation` discriminated union (9 kinds) | Replaced | `Operation` string union (4 values) |
| `Browse`, `Get`, `GetById` | Merged | `read` with id parameterization |
| `Transition(op)` | Absorbed | `update` with lifecycle validation |
| `Act`, `Process` | Removed | Actions are concerns; process is gone |

## Name validation

Entity names must satisfy:
- Non-empty
- Lowercase alphanumeric plus underscores
- No leading/trailing underscores
- No consecutive underscores
- Maximum 64 characters
- Directly usable as SQL table names (no escaping needed)

All entities — framework and consumer — use the same naming convention. Framework vs consumer is distinguished by the `origin` field, not naming convention.

```ts
const ENTITY_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
```

Examples: `note`, `published_notes`, `graph_node`, `emit_records`, `connector_binding`, `rate_limit_records`.

## Testing gate

When 124-01 is implemented, the following should be testable:

- `define()` returns a frozen `DefineResult` with `kind: 'define'`
- `define()` with `Persistent()` produces `operations: ['read', 'create', 'update', 'delete']`
- `define()` with `Singleton()` produces `operations: ['read', 'update']`
- `define()` with `Derived()` produces `operations: ['read']`
- `define()` with `Virtual()` produces `operations: ['read']`
- `define()` with `Volatile()` produces `operations: ['read', 'create', 'update', 'delete']`
- Schema with `Lifecycle()` field produces correct `lifecycles` and `transitionTargets`
- Schema with `Relation()` field produces correct `wiringFields`
- `classifiedSchema` and `sensitivity` are derived correctly
- Multiple `define()` calls produce independent records (no shared mutable state)
- Invalid entity names are rejected (hyphens, colons, uppercase, leading underscore)
- The returned record is deeply frozen
