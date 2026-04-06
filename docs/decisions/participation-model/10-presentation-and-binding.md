# 124-10: Binding Model

**Status:** Draft
**Date:** 2026-04-03
**Depends on:** [00](00-vocabulary.md) (Vocabulary), [01](01-core-records-and-define.md) (Core Records), [02](02-wiring-functions.md) (Wiring Functions), [09](09-agent-surface-and-session.md) (Agent Surface)

## Scope

This sub-ADR specifies:
- `BindingRecord` — the entity-to-rendering junction, carrying field metadata and agent interaction levels
- `bind()` — produces binding records with direct component references
- `BindingContext` and `FieldState` — runtime signal-based state with committed/current/dirty tracking
- Field metadata — semantic type, agent interaction level, rendering hint per field
- Binding index — compiled from binding records for fast lookup
- Agent visibility — how agents read, diff, and write to binding contexts
- How Derived() entities handle complex view requirements
- The three wiring domains (participation, subscription, binding)

This sub-ADR does NOT cover:
- Rendering infrastructure (Preact, SSR, hydration, CSS) — see [12b](12b-client-entity-cache.md)
- Connection protocol and sync — see [12a](12a-connection-protocol-and-sync.md)
- Session entity — see [09](09-agent-surface-and-session.md)

## Context

The participation model compiles entities, wires pipelines, and dispatches operations — all server-side. But there is no specification for how entities become visible to humans and agents on a page.

Janus is an agent harness. The web UI is a projection of the entity graph that agents and humans share as co-participants. The binding model is the contract between entity data and this shared surface. It must satisfy two consumers:

1. **Humans** — see rendered components with editable fields
2. **Agents** — see structured metadata (what's on the page, what's editable, what changed) and can read/write field values in real time

The binding model is framework-independent — it defines data structures and contracts, not rendering technology. The rendering infrastructure ([12b](12b-client-entity-cache.md)) implements these contracts using Preact and `@preact/signals`.

## Decision

### BindingRecord

The junction connecting a graph-node to a component, carrying per-entity rendering configuration and agent-facing metadata:

```ts
interface BindingRecord {
  readonly source: string;                    // Reference → GraphNodeRecord.name
  readonly component: ComponentType;          // Direct TypeScript reference to the component
  readonly view: string;                      // 'detail', 'list', 'form', 'card', etc.
  readonly config: BindingConfig;
}
```

| Field | Description |
|-------|-------------|
| `source` | The entity being bound. Reference to a graph-node name. |
| `component` | Direct TypeScript reference to the rendering component (a `.tsx` function). Not a string — an importable value. |
| `view` | A label identifying this binding. Used by the session entity to track what the user is looking at, and by the agent to understand the page layout. |
| `config` | Per-entity rendering configuration: field metadata, columns, layout. |

### BindingConfig and FieldBindingConfig

```ts
interface BindingConfig {
  readonly fields?: Record<string, FieldBindingConfig>;
  readonly columns?: readonly string[];      // for list views: visible columns in order
  readonly layout?: string;                  // layout hint: 'single-column', 'two-column', 'tabbed'
}

interface FieldBindingConfig {
  readonly component?: string;               // rendering hint: 'heading', 'richtext', 'badge', 'date-picker'
  readonly agent: AgentInteractionLevel;     // 'read-write', 'read', 'aware'
  readonly label?: string;                   // display label (defaults to field name)
  readonly visible?: boolean;                // default: true. false = not rendered in this view
}

type AgentInteractionLevel = 'read-write' | 'read' | 'aware';
```

**Agent interaction levels:**

| Level | Agent can | Component behavior |
|-------|-----------|-------------------|
| `read-write` | Read current/committed values, write to current (suggest edits) | Editable input |
| `read` | Read current/committed values | Read-only display |
| `aware` | Knows the field exists and its type, but does not receive values | Rendered but not exposed to agent |

**Fields not in `config.fields` are not rendered in this view.** The agent can trust that the binding config is the complete field inventory for a given view. This is an explicit rule, not implicit.

### bind()

```ts
function bind(
  entity: string | DefineResult,
  bindings: readonly BindingInput[],
): BindResult

interface BindingInput {
  readonly component: ComponentType;
  readonly view: string;
  readonly config: BindingConfig;
}

interface BindResult {
  readonly kind: 'bind';
  readonly records: readonly BindingRecord[];
}
```

### Example

```ts
import { NoteDetail } from './components/NoteDetail';
import { NoteList } from './components/NoteList';
import { NoteCard } from './components/NoteCard';

bind('note', [
  {
    component: NoteDetail,
    view: 'detail',
    config: {
      fields: {
        title: { component: 'heading', agent: 'read-write', label: 'Title' },
        body: { component: 'richtext', agent: 'read-write' },
        status: { component: 'badge', agent: 'read' },
        author: { component: 'user-link', agent: 'read' },
      },
      layout: 'single-column',
    },
  },
  {
    component: NoteList,
    view: 'list',
    config: {
      columns: ['title', 'status', 'author'],
      fields: {
        title: { agent: 'read' },
        status: { agent: 'read' },
        author: { agent: 'read' },
      },
    },
  },
  {
    component: NoteCard,
    view: 'card',
    config: {
      fields: {
        title: { component: 'heading', agent: 'read' },
        status: { component: 'badge', agent: 'aware' },
      },
    },
  },
]);
```

### Binding index

Compiled from binding records for fast lookup:

```ts
interface BindingIndex {
  byEntity(entity: string): readonly BindingRecord[];
  byView(view: string): readonly BindingRecord[];
  byEntityAndView(entity: string, view: string): BindingRecord | undefined;
}

function buildBindingIndex(bindings: readonly BindingRecord[]): BindingIndex
```

The binding index is built during `compile()` and included on the `CompileResult`. It enables the agent to discover what views are available for each entity and the rendering infrastructure to resolve which component to render.

### BindingContext and FieldState

At runtime, when an entity is rendered on a page, a **binding context** is created from the binding record and entity data. This is the live, signal-based state that components render from and agents observe:

```ts
interface FieldState<T = unknown> {
  readonly committed: Signal<T>;              // last persisted value
  readonly current: Signal<T>;               // live value on screen (user edits, agent suggestions)
  readonly dirty: ReadonlySignal<boolean>;   // committed !== current
  readonly meta: FieldMeta;
}

interface FieldMeta {
  readonly type: string;                      // semantic type from graph-node schema
  readonly agent: AgentInteractionLevel;     // from FieldBindingConfig
  readonly component?: string;               // rendering hint from FieldBindingConfig
  readonly label?: string;
}

interface BindingContext {
  readonly entity: string;
  readonly id: string | null;                 // null for list/collection views
  readonly view: string;
  readonly fields: Readonly<Record<string, FieldState>>;
  readonly dirty: ReadonlySignal<boolean>;   // true if any field is dirty
  readonly records?: readonly RecordContext[];  // for list views: per-record state
}

interface RecordContext {
  readonly id: string;
  readonly fields: Readonly<Record<string, FieldState>>;
  readonly dirty: ReadonlySignal<boolean>;
}
```

`Signal` and `ReadonlySignal` are from `@preact/signals-core` — framework-agnostic reactive primitives that work in any TypeScript file without a special compiler.

### Creating a binding context

```ts
function createBindingContext(
  entity: string,
  id: string | null,
  view: string,
  binding: BindingRecord,
  record: EntityRecord,
  schema: Record<string, string>,   // field name → semantic type
): BindingContext
```

For each field in `binding.config.fields`:
1. Read the current value from the entity record
2. Create `committed` signal (last persisted value)
3. Create `current` signal (starts equal to committed)
4. Create `dirty` computed signal (committed !== current)
5. Build `FieldMeta` from the binding config + schema

Fields not in `binding.config.fields` are not included — they are not part of this view.

### Field state lifecycle

| Event | committed | current | dirty |
|-------|-----------|---------|-------|
| Initial load | record value | record value | false |
| User edits a field | unchanged | user's input | true |
| Agent writes to field | unchanged | agent's value | true |
| Save succeeds | updated to server response | unchanged | false |
| Server push (field not dirty) | updated | updated | false |
| Server push (field is dirty) | updated | unchanged (user edits preserved) | true |
| User reverts | unchanged | reset to committed | false |

When a server push arrives for a field the user has edited (dirty), `committed` updates but `current` does not. The user's unsaved work is preserved. The UI can surface the conflict: "This field was updated by someone else while you were editing."

### Agent interaction with binding contexts

The agent reads binding contexts from the **binding registry** ([12b](12b-client-entity-cache.md)) — a plain TypeScript interface that tracks all active contexts on the page.

#### Agent reads the page

```ts
const contexts = bindingRegistry.getActiveContexts();

for (const ctx of contexts) {
  // "What entities are on this page?"
  // → note:123 (detail), event:null (list)

  for (const [name, field] of Object.entries(ctx.fields)) {
    // "What fields are visible?"
    // → title (Str, read-write), body (Markdown, read-write), status (Lifecycle, read)

    // "What are the current values?"
    // → field.current.value

    // "What was the last saved value?"
    // → field.committed.value

    // "Has the user edited this?"
    // → field.dirty.value
  }
}
```

#### Agent diffs user edits

```ts
// "What did the user change?"
for (const ctx of contexts) {
  for (const [name, field] of Object.entries(ctx.fields)) {
    if (field.dirty.value) {
      console.log(`${name}: "${field.committed.value}" → "${field.current.value}"`);
    }
  }
}
```

#### Agent suggests an edit

```ts
// Write to current — user sees it as an unsaved edit (preview)
noteCtx.fields.title.current.value = 'Agent-suggested title';

// The component re-renders immediately. dirty becomes true.
// The user decides: save (commit) or revert (reset to committed).
```

#### Agent observes changes in real time

```ts
import { effect } from '@preact/signals-core';

// Plain TypeScript — works outside the component tree
effect(() => {
  console.log('Title is now:', noteCtx.fields.title.current.value);
});
```

### User attention (pointer and focus state)

The binding registry tracks where the user's attention is — which field has keyboard focus and which field the mouse is hovering over:

```ts
interface FieldPointer {
  readonly entity: string;
  readonly id: string | null;
  readonly field: string;
  readonly view: string;
}
```

These are signals on the binding registry:

```ts
interface BindingRegistry {
  getActiveContexts(): readonly BindingContext[];
  readonly focus: Signal<FieldPointer | null>;   // keyboard focus
  readonly hover: Signal<FieldPointer | null>;   // mouse hover
  // ...
}
```

Field components report hover/focus as part of their standard behavior. The framework provides this wiring — the consumer's component doesn't need to add it manually.

**Why this matters for agents:** The user can say "this doesn't look right" or "can you tell me more about this?" and the agent knows what "this" refers to without the user describing it. The agent reads `focus` or `hover` and resolves it to a specific entity, field, and value.

```ts
const focus = bindingRegistry.focus.value;
if (focus) {
  const ctx = contexts.find(c => c.entity === focus.entity && c.id === focus.id);
  const field = ctx?.fields[focus.field];
  // Agent knows: user is focused on note:123.status, value is 'draft', type is Lifecycle
}
```

**Reactivity gating:** Pointer state is not pushed to the agent on every mouse move. Two strategies:

1. **On-demand** — the agent reads the current pointer value when the user asks a deictic question ("this", "here", "that field"). No continuous observation.
2. **Debounced observation** — if the agent is actively in conversation, an `effect()` with debounce (e.g., 500ms settle time) reports attention changes. Outside active conversation, no observation runs.

The framework does not continuously stream pointer data. It makes the signals available; the agent harness decides when to read them.

### Multi-entity page awareness

A page can render multiple entities simultaneously — a note detail, a list of related events, a venue card in a sidebar. Each gets its own binding context. The agent sees all of them:

```ts
const contexts = bindingRegistry.getActiveContexts();
// → [
//   { entity: 'note', id: '123', view: 'detail', fields: { title, body, status } },
//   { entity: 'event', id: null, view: 'list', records: [{ id: '456', fields: {...} }, ...] },
//   { entity: 'venue', id: '012', view: 'card', fields: { name, address } },
// ]
```

The session entity tracks all active binding contexts, not just one focus entity. The agent can reason about relationships: "The user is viewing note:123, which mentions events 456 and 789 that are also visible in the list below."

### Complex views via Derived entities

Complex views — denormalized data, computed fields, aggregations — are handled on the entity side, not the presentation side. They are `Derived()` storage entities:

```ts
const publishedNotes = define('published-notes', {
  schema: {
    title: Str({ required: true }),
    authorName: Str({ required: true }),
    publishedAt: DateTime({ required: true }),
    excerpt: Str(),
  },
  storage: Derived({
    source: 'note',
    filter: { status: 'published' },
    compute: (note, context) => ({
      title: note.title,
      authorName: context.resolve('user', note.authorId)?.name ?? 'Unknown',
      publishedAt: note.updatedAt,
      excerpt: note.body?.substring(0, 200),
    }),
  }),
});

bind('published-notes', [
  { component: PublishedNoteList, view: 'list', config: {
    columns: ['title', 'authorName', 'publishedAt'],
    fields: {
      title: { agent: 'read' },
      authorName: { agent: 'read' },
      publishedAt: { agent: 'read' },
    },
  }},
]);
```

The Derived entity handles joins, computations, and aggregations. The binding layer stays trivial — entity fields → rendering components.

### Three wiring domains

Presentation/binding is the third wiring domain alongside pipeline (participation) and events (subscription). All three share the same pattern — a junction record connecting entities to infrastructure:

| Domain | What it wires | Junction record | Consumer function |
|--------|--------------|----------------|-------------------|
| Pipeline | How data flows through dispatch | ParticipationRecord | participate() |
| Events | What happens after/outside dispatch | SubscriptionRecord | subscribe() |
| Presentation | How data reaches rendering + agents | BindingRecord | bind() |

Pipeline and event junctions carry a `handler` field (Handler() key → function). Binding junctions carry a `component` field (direct TypeScript reference → rendering function). The difference reflects the consumer: handlers run on the server inside the dispatch pipeline; components run on the client as rendered UI.

## Testing gate

When 124-10 is implemented:

- `bind('note', [...])` produces correct BindingRecords with direct component references
- Multiple bindings per entity (detail, list, card) produce separate records
- Binding config with `fields` carries field-level agent interaction levels and rendering hints
- Binding config with `columns` carries column list for list views
- Fields not in `config.fields` are excluded from the binding context
- Binding index lookup by entity returns all bindings for that entity
- Binding index lookup by (entity, view) returns single binding
- `compile()` includes binding index on the result
- `createBindingContext()` creates field-level signals from entity record + binding config
- `committed` and `current` signals start equal, `dirty` is false
- Writing to `current.value` makes `dirty` true
- `FieldMeta` carries semantic type, agent interaction level, component hint
- Derived entity can be bound to views like any other entity
- Agent reads field values via `.committed.value` and `.current.value` from plain TypeScript
- Agent writes to `.current.value` — dirty becomes true
- `effect()` from `@preact/signals-core` observes signal changes from plain TypeScript
- Multi-entity: multiple binding contexts can coexist, each with independent field state
- `bindingRegistry.focus` updates when a field receives keyboard focus
- `bindingRegistry.hover` updates when a field is hovered
- `bindingRegistry.focus.value` returns `FieldPointer` with entity, id, field, view
- Agent reads focus/hover to resolve deictic references ("this field")
