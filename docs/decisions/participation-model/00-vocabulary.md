# 124-00: Vocabulary

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** ADR-124 (Participation Model)

## Scope

This sub-ADR specifies the vocabulary boundary for packages/next-next: what imports unchanged from `@janus/vocabulary`, what simplifies, what's new, and what's removed. It is the foundation all other sub-ADRs build on.

## Imports unchanged

These carry forward from `@janus/vocabulary` with no modifications:

| Category | Constructors | Count |
|----------|-------------|-------|
| Semantic types | `Str`, `Int`, `Float`, `Bool`, `Email`, `Phone`, `Url`, `Token`, `DateTime`, `Duration`, `Cron`, `Color`, `Icon`, `Asset`, `QrCode`, `LatLng`, `Markdown`, `Recurrence`, `Scope`, `Slug`, `Enum`, `Json` | 22 value |
| Compound types | `Id`, `IntCents`, `IntBps`, `Availability` | 4 |
| Wiring types | `Relation`, `Reference`, `Mention` | 3 |
| Storage strategies | `Persistent`, `Singleton`, `Volatile`, `Derived`, `Virtual` | 5 |
| Classifications | `Public`, `Private`, `Sensitive` | 3 |
| Lifecycle | `Lifecycle`, `defineLifecycle` | 2 |
| Audit levels | `AuditFull`, `AuditLight`, `AuditNone` | 3 |
| Duration helpers | `seconds`, `minutes`, `hours`, `days`, `weeks`, `parseDuration` | 6 |
| Invariants | `Invariant` constructor, `InvariantSeverity` type | 2 |

These are pure data constructors with no runtime behavior. They produce frozen discriminated union values. No changes needed.

**Type-level imports** also carry forward: `SemanticField`, `WiringType`, `StorageStrategy`, `StorageStrategyMode`, `ClassifiedSchema`, `Classification`, `Sensitivity`, `LifecycleDescriptor`, `AuditLevel`, `InvariantDescriptor`, and all semantic field types (`StrField`, `IntField`, etc.).

## Operation type (simplified)

The nine-kind discriminated union collapses to four string literals:

```ts
// packages/next (current)
type Operation =
  | { kind: 'browse' }
  | { kind: 'get' }
  | { kind: 'getById' }
  | { kind: 'create' }
  | { kind: 'update' }
  | { kind: 'delete' }
  | { kind: 'transition'; operation: string }
  | { kind: 'act'; action: string }
  | { kind: 'process' };

// packages/next-next
type Operation = 'read' | 'create' | 'update' | 'delete';
```

| Removed | Absorbed into |
|---------|--------------|
| `browse`, `get`, `getById` | `read` (parameterized by id presence) |
| `transition` | `update` (validate concern checks lifecycle legality) |
| `act` | Custom action concerns at order=35 |
| `process` | Removed (transport chains dissolved into initiator join) |

## Event descriptors (simplified)

Four event descriptors, down from eight:

```ts
type EventDescriptor =
  | { readonly kind: 'created' }
  | { readonly kind: 'updated' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'acted'; readonly action: string }
  ;

const Created: EventDescriptor = Object.freeze({ kind: 'created' });
const Updated: EventDescriptor = Object.freeze({ kind: 'updated' });
const Deleted: EventDescriptor = Object.freeze({ kind: 'deleted' });
const Acted = (action: string): EventDescriptor => Object.freeze({ kind: 'acted', action });
```

| Removed | Rationale |
|---------|-----------|
| `Retrieved` | Reads don't emit events |
| `Browsed` | Reads don't emit events |
| `Transitioned` | A transition is an `Updated` event — the lifecycle field change is visible in the before/after diff |
| `ActionInvoked` | Collapsed into `Acted` |

Reads never trigger the emit concern. Only writes (create, update, delete) and custom actions produce events. This simplifies the broker, subscription filtering, and audit trail.

`Acted` carries the action name so subscriptions can filter on specific actions:

```ts
subscribe('note', [
  { on: Acted('pin'), handler: 'dispatch-adapter', config: { ... } },
]);
```

## New types

Small additions specific to the participation model:

```ts
// Who owns the entity definition
type Origin = 'framework' | 'consumer';

// What the agent can do with a field
type AgentInteractionLevel = 'read-write' | 'read' | 'aware';

// What kind of custom action
type ActionKind = 'query' | 'mutation' | 'effect';

// What to do when a subscription fails
type FailurePolicy = 'log' | 'retry';

// How the entity is rendered (on BindingRecord, used by preset functions)
type PresentationModality = 'visual' | 'voice' | 'text';
```

### Backend-resolved column types

Five semantic column types that store a compact reference in the database and resolve from a separate backend. Each follows the same pattern: **DB stores a pointer, backend stores the content, resolve bridges them.**

| Column type | DB stores | Backend | Resolves to | Specified in |
|-------------|-----------|---------|-------------|-------------|
| `Asset()` | `{ backend, path }` | File system / S3 | Metadata + URL | [08b](08b-assets-and-media.md) |
| `Append()` | `{ file, offset }` | JSONL append files | Parsed JSON payload | [04b](04b-append-storage-and-execution-log.md) |
| `Template()` | `{ path }` | Template source files | Source string | [10b](10b-template-column-type-and-rendering.md) |
| `Handler()` | key string | Runtime function registry | Function reference | [02](02-wiring-functions.md) |
| `Channel()` | protocol identifier | Live stream/socket handle | Stream/socket connection (runtime) | [12a](12a-connection-protocol-and-sync.md) |

```ts
// Constructors
function Asset(): SemanticType
function Append(config?: { rotation?: 'daily' | 'weekly' | 'monthly' }): SemanticType
function Template(config?: { format?: 'html' | 'markdown' | 'text' }): SemanticType
function Handler(): SemanticType
function Channel(config?: { protocols?: readonly string[] }): SemanticType  // default: ['sse', 'websocket']
```

`Asset()` carries forward from `@janus/vocabulary`. `Append()`, `Template()`, `Handler()`, and `Channel()` are new to next-next.

## Removed

| Removed | Rationale |
|---------|-----------|
| `InternalExecution`, `ServerExecution`, `TransportExecution` | No `kind` field — participation records determine pipeline shape |
| `createStepConstructor()`, `StepConfig` | No StepDefinition interface |
| `Validate()`, `Audit()`, `Parse()`, `Emit()`, `Observe()`, `Respond()`, `Policy()` capability constructors | Config shapes live directly on `ParticipateConfig` — no wrapper needed |
| `RealmKind` (`domain` / `framework` / `operational`) | Replaced by `Origin` |
| `EntityKind` (`server` / `transport` / `client`) | Removed entirely — determined by participation |
| `MountTrust`, `sensitivityAllowsMount` | Mount concept removed |
| `ExecutionRecord`, `execution()` entity/registration | No execution entity — `Handler()` column on junction records resolves directly from runtime registry ([02](02-wiring-functions.md)) |
| `ConcernRecord`, `concern()` registration function | Pipeline placement (order, transactional) lives on ParticipationRecord ([02](02-wiring-functions.md)) |
| `PresentationRecord`, `presentation()` registration function | Rendering metadata (modality, component, template, format) lives on BindingRecord ([10](10-presentation-and-binding.md)) |

## Type guards

Carried forward with adjustments:

```ts
// Storage strategy guards (unchanged)
isPersistent(s: StorageStrategy): s is PersistentStrategy
isSingleton(s: StorageStrategy): s is SingletonStrategy
isVolatile(s: StorageStrategy): s is VolatileStrategy
isDerived(s: StorageStrategy): s is DerivedStrategy
isVirtual(s: StorageStrategy): s is VirtualStrategy

// Wiring type guards (unchanged)
isRelation(f: unknown): f is RelationField
isReference(f: unknown): f is ReferenceField
isMention(f: unknown): f is MentionField
isWiringType(f: unknown): f is WiringType

// Semantic type guard (unchanged)
isSemanticField(f: unknown): f is SemanticField

// Event descriptor guards (simplified)
isMutationEvent(e: EventDescriptor): boolean  // created | updated | deleted
isActedEvent(e: EventDescriptor): e is { kind: 'acted'; action: string }
```

## Package boundary

The vocabulary package (`@janus/vocabulary`) is imported by next-next but not modified. The new types (`Origin`, `AgentInteractionLevel`, `ActionKind`, `FailurePolicy`) and simplified types (`Operation`, `EventDescriptor`) are defined in the next-next packages, not added to vocabulary.

This means:
- `@janus/vocabulary` remains the shared type foundation (semantic types, storage, wiring, lifecycle, classifications)
- `@janus/types` (or equivalent) defines the participation-model-specific types
- No circular dependency between the two

## Testing gate

When 00 is implemented (really just type definitions and constructors):

- `Operation` is a 4-value string literal union
- `Created`, `Updated`, `Deleted` are frozen event descriptors
- `Acted('pin')` returns frozen descriptor with action name
- All vocabulary imports resolve correctly
- Removed types (`EntityKind`, `RealmKind`, capability constructors, execution presets) are NOT re-exported
- New types (`Origin`, `AgentInteractionLevel`, `ActionKind`, `FailurePolicy`) are available
- Backend-resolved column types: `Append()`, `Template()`, `Handler()`, `Channel()` constructors return valid semantic types
- `Asset()` carries forward unchanged from vocabulary
- Type guards work correctly for the simplified event descriptors
