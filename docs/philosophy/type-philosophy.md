# Type Philosophy: Compile-Time Certainty

If it compiles, it works. Every runtime failure that can be caught by the type system should be caught by the type system.

This document is the foundational design principle for Janus. Every package — from `@janus/types` through `@janus/engine` to `@janus/agent` — is built on these ideas.

## Anti-Goals

- Runtime casts as a substitute for real contracts.
- Duplicate type declarations that drift across layers.
- Accepting structural regressions because tests still pass.

## Principle Scorecard

| Principle | Observable behavior | Metric |
|-----------|---------------------|--------|
| Exhaustive dispatch | Adding a `ToolNameKind` variant fails builds until all handlers exist | `tsc` errors on missing switch cases |
| Semantic primitives | `IntCents` and `IntBps` carry meaning through schema metadata | Agent prompts reflect semantic types, not raw numbers |
| One definition, two uses | Entity definition changes propagate to engine AND agent | Zero hand-maintained tool descriptions |
| Declaration over configuration | Entity wiring is typed object declarations, not string registries | New entities compile without runtime registry edits |

## Principles

### 1. Exhaustive dispatch, not conditional dispatch
Every variant of a union type must be handled. The mechanism is `satisfies Record<Union, Handler>` or exhaustive `switch` — not if-else chains, not `default` fallthrough. When you add a variant, the compiler tells you every place that needs a handler.

In Janus, `ToolNameKind` defines five dispatch variants. The engine's `routeToHandler` switch in `engine/dispatch.ts` handles all five — adding a sixth kind without a handler is a compile error:

```typescript
type ToolNameKind = 'browse' | 'self-operation' | 'batch' | 'cross-entity' | 'cross-entity-batch';

// engine/dispatch.ts — every kind has a handler
switch (tn.kind) {
  case 'browse':           return handleBrowse(graph, store, tn, input, identity);
  case 'self-operation':   return handleSelfOperation(graph, store, tn, input, identity);
  case 'batch':            return handleBatch(graph, store, tn, input, identity);
  case 'cross-entity':     return handleCrossEntity(graph, store, tn, input, identity);
  case 'cross-entity-batch': return handleCrossEntityBatch(graph, store, tn, input, identity);
}
```

This applies to tool name kinds, invariant kinds, lifecycle operations — anything with variants.

### 2. Tagged unions over string enums
A discriminated union carries its payload shape with its discriminant. The `kind` field narrows to the exact variant. No casting, no `as unknown as`, no runtime checks for "does this field exist."

Invariants in `entity/invariants.ts` use this pattern — each kind carries different fields:

```typescript
type InvariantKind = 'count-below' | 'time-gate' | 'in-state' | 'field-required' | 'field-compare' | 'custom';

interface CountBelowInvariant extends InvariantBase<'count-below'> {
  readonly entityRef: string;
  readonly filter: CountFilter;
  readonly field: string;
}
```

The type *is* the documentation. Reading the union tells you every possible shape.

### 3. Semantic primitives over raw values
An `IntCents` and an `IntBps` are both numbers, but they mean different things. Janus's semantic type constructors in `types/schema-types.ts` attach meaning to Zod schemas via metadata:

```typescript
export function IntCents(): SemanticSchema<'IntCents', z.ZodNumber> {
  return withMeta(z.number().int(), { semanticType: 'IntCents' as const });
}

export function IntBps(): SemanticSchema<'IntBps', z.ZodNumber> {
  return withMeta(z.number().int(), { semanticType: 'IntBps' as const });
}
```

The semantic type carries through the entire system — entity schemas, graph construction, agent prompt generation. The agent sees `priceCents: IntCents` and knows it's money in cents, not a raw integer.

### 4. One definition, two uses
A single declaration should serve both runtime behavior and compile-time checking. In Janus, this is the central idea: an entity definition simultaneously serves as the engine's dispatch target AND the agent's tool description.

```typescript
// One definition...
export const Event = defineEntity('event', Public({
  id: Id(), title: Str(), startsAt: IntMs(), capacity: Int(),
  priceCents: IntCents(),
  status: PublishingLifecycle.with({
    publish: { invariants: [hasTitle, hasSchedule] },
  }),
}));

// ...two uses:
// 1. Engine dispatch: graph validates operations, checks invariants, routes handlers
// 2. Agent discovery: graph derives tool names, generates prompts, describes parameters
```

If you're writing the same information twice — once for the engine and once for the agent — find the pattern that lets you write it once. The entity graph *is* that pattern.

### 5. Shared schemas as the contract
The entity graph is the single contract for every consumer. Engine dispatch, agent tools, and future HTTP or presentation layers all derive from the same `EntityDefinition` objects. A change to an entity schema is visible everywhere — no separate API spec, no manual client wrappers, no "the agent expects this field" comments.

### 6. Boundary discipline
Inside the type boundary, everything is typed and trusted. No runtime checks, no defensive coding, no `typeof x === "string"` guards. At the boundary — agent input, HTTP requests, external APIs — Zod validates and normalizes. The boundary is explicit: parse once, trust forever.

```
[agent / HTTP / external] → Zod parse (entity schema) → [typed interior: engine dispatch] → [typed result]
```

Entity schemas carry classification metadata (`Public`, `Member`, `Sensitive`) so the boundary also enforces data visibility.

### 7. Generic parameters as structural contracts
When an entity declares its schema, the generic parameters thread type safety through the entire chain. `ClassifiedSchema<C, Shape>` carries both the classification level and the field shape. The entity definition constrains what operations are valid, what invariants apply, and what the agent can describe.

```typescript
export type ClassifiedSchema<
  C extends Classification = Classification,
  Shape extends z.ZodRawShape = z.ZodRawShape,
> = z.ZodObject<Shape> & { readonly meta: ClassificationMeta<C> };
```

Defining an entity with `Public({...})` vs `Sensitive({...})` changes how the graph exposes it — one declaration, multiple guarantees.

### 8. Mapped types close loops
When entity definitions produce operations and the engine consumes them, the mapping should be a type. Adding a new lifecycle operation without a dispatch handler should be a compile error.

In Janus, `LifecycleField` is simultaneously a Zod schema (validates state values) and a `LifecycleDef` (defines operations and transitions). The engine extracts operations from the lifecycle and dispatches against them — one object, two roles, no gap between what's declared and what's executable.

This applies at every boundary: entity definition → graph construction → engine dispatch → agent tool. Each hop is a typed mapping, not an implicit convention.

### 9. End-to-end type flow
The entity definition's schema should flow directly to every consumer. No manual wrapper functions, no "the agent expects this shape" comments. The entity definition *is* the dispatch contract *is* the agent tool description.

### 10. Declaration over configuration
Entities, operations, lifecycles, relations — declared as typed objects. Not registered through runtime APIs, not configured through string lookups, not wired through dependency injection. If the wiring can be expressed as a type, express it as a type.

```typescript
// Declaration, not configuration:
const Event = defineEntity('event', Public({
  id: Id(), title: Str(), priceCents: IntCents(),
  status: PublishingLifecycle.with({ publish: { invariants: [hasTitle] } }),
  venue: Relation(Facility, { cascade: { archive: 'cancel' } }),
}));

// The graph, engine, and agent all derive behavior from this declaration.
// No runtime registry calls. No string-based wiring.
```

## What This Adds Up To

**Entity-to-agent type flow.** Entity definition → graph construction → engine dispatch → agent tool. One chain, no gaps.

**Refactor confidence.** Rename a field, change a union variant, add a lifecycle state — the compiler shows you every callsite. If it compiles, nothing was missed.

**Zero implicit contracts.** The type system is the documentation, the dispatch contract, and the agent's tool description — all in one artifact.

**Migrations as compiler-guided tours.** When a concept changes — a lifecycle gains a state, an entity adds a relation, a semantic type changes from `Int` to `IntCents` — you change the type in one place and the compiler produces an exhaustive list of every file, every function, every callsite that needs updating. No grepping, no "did I miss one," no runtime surprises. The migration *is* the compile error list. Work through it top to bottom, and when it compiles, the migration is complete.

## How This Connects to the Entity Graph

The Type Philosophy establishes the encoding mechanism — discriminated unions, semantic types, `satisfies Record`, generic parameters — that every Janus package uses to express its contracts:

- **`@janus/types`** defines semantic schema constructors (`Id`, `Str`, `IntCents`, `IntBps`) and classification (`Public`, `Member`, `Sensitive`) — the vocabulary of Principle 3.
- **`@janus/entity`** uses `defineEntity` to create declarations that serve both dispatch and discovery — Principle 4 in action.
- **`@janus/graph`** derives tool names from entity definitions and validates the DAG — Principle 8's typed mapping from declaration to dispatch.
- **`@janus/engine`** dispatches exhaustively on `ToolNameKind` — Principle 1 at the core of execution.
- **`@janus/agent`** calls the same `dispatch` function the engine uses, with the same graph — Principle 5's shared contract, from machine to machine.
