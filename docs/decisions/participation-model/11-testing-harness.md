# 124-11: Testing Harness and Proof Entities

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md)–[10](10-presentation-and-binding.md) (all sub-ADRs)

## Scope

This sub-ADR specifies:
- `createTestHarness()` — one-liner test setup for packages/next-next
- `TestHarness` interface
- Proof entity family rewritten for the participation model
- `createProofHarness()` — pre-configured harness with all proof entities
- Event capture mechanism
- How proof entities exercise all four consumer functions

This sub-ADR does NOT cover:
- Production deployment
- Performance benchmarks
- Surface integration tests (those belong in [08](08-http-surface-and-bootstrap.md)/[09](09-agent-surface-and-session.md) testing gates)

## createTestHarness()

The standard test setup. Compiles declarations, wires store + pipeline + broker, returns a dispatch-ready harness:

```ts
async function createTestHarness(config: TestHarnessConfig): Promise<TestHarness>

interface TestHarnessConfig {
  readonly declarations: readonly DeclarationRecord[];
  readonly initiators?: readonly InitiatorConfig[];
  readonly defaultIdentity?: Identity;
  readonly maxDepth?: number;
  readonly enableSubscriptions?: boolean;  // default: false (opt-in for tests)
  readonly useSqlite?: boolean;            // default: false (memory adapter)
}
```

### Behavior

1. Merge framework declarations (seeded executions, pipeline output entities) with consumer declarations.
2. Merge framework initiators (system) with any provided initiators.
3. `compile(allDeclarations, allInitiators)` → CompileResult.
4. Create entity store (memory adapter by default, SQLite if `useSqlite: true`).
5. Initialize store adapters.
6. Create broker with event capture.
7. Create dispatch runtime.
8. Optionally start subscription processor.
9. Return `TestHarness`.

## TestHarness

```ts
interface TestHarness {
  // Core infrastructure
  readonly registry: CompileResult;
  readonly store: EntityStore;
  readonly broker: Broker;
  readonly runtime: DispatchRuntime;

  // Captured events (for assertions)
  readonly events: readonly DomainEvent[];

  // Convenience dispatch (system initiator by default)
  dispatch(
    entity: string,
    operation: string,
    input: unknown,
    identity?: Identity,
    initiator?: string,
  ): Promise<DispatchResponse>;

  // Direct store access (bypasses pipeline — for test setup/assertions)
  seed(entity: string, records: readonly Record<string, unknown>[]): Promise<EntityRecord[]>;

  // Event capture
  resetEvents(): void;

  // Cleanup
  shutdown(): Promise<void>;
}
```

### dispatch() convenience

The harness `dispatch()` defaults to:
- Initiator: `'system'`
- Identity: `config.defaultIdentity ?? SYSTEM`

This means most test calls are simply:
```ts
const result = await harness.dispatch('note', 'create', { title: 'Test' });
```

### seed() convenience

Inserts records directly into the store, bypassing the pipeline. Useful for test setup:
```ts
await harness.seed('user', [{ id: 'alice', name: 'Alice', roles: ['admin'] }]);
```

### Event capture

The harness wraps the broker to capture all emitted events:
```ts
// In test:
await harness.dispatch('note', 'create', { title: 'Test' });
expect(harness.events).toHaveLength(1);
expect(harness.events[0].descriptor).toBe('created');

harness.resetEvents();
```

## Proof entities

A canonical set of test entities that exercise the full consumer API. These replace the packages/next proof entities (Note, Event, Venue, Registration, User) with the participation model API.

### Note (Persistent, lifecycle, relations, full participation)

```ts
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

const noteParticipation = participate('note', {
  audit: AuditFull,
  observe: { on: [Created, Updated] },
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'user', operations: ['read', 'create'], ownershipField: 'authorId' },
    ],
    anonymousRead: true,
  },
  invariant: [
    { name: 'title-not-empty', predicate: (r) => (r.title as string)?.length > 0, severity: 'error' },
  ],
  actions: {
    pin: {
      handler: async (ctx) => {
        await ctx.store.update(ctx.entity, ctx.parsed.id as string, { pinned: true });
        return { pinned: true };
      },
      kind: 'mutation',
      scoped: true,
      description: 'Pin a note',
    },
  },
});

const noteSubscriptions = subscribe('note', [
  { on: Created, handler: 'dispatch-adapter', config: { entity: 'feed', action: 'notify' } },
]);

const noteBindings = bind('note', [
  { component: NoteDetail, view: 'detail', config: {
    fields: { title: { component: 'heading', agent: 'read-write' }, body: { component: 'richtext', agent: 'read-write' }, status: { component: 'badge', agent: 'read' } },
  }},
  { component: NoteList, view: 'list', config: {
    columns: ['title', 'status', 'author'],
    fields: { title: { agent: 'read' }, status: { agent: 'read' }, author: { agent: 'read' } },
  }},
]);
```

### User (Persistent, simple)

```ts
const user = define('user', {
  schema: {
    name: Str({ required: true }),
    email: Email({ required: true }),
    role: Str({ required: true }),
  },
  storage: Persistent(),
});

const userParticipation = participate('user', {
  audit: AuditFull,
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'user', operations: ['read'] },
    ],
  },
});
```

### AppConfig (Singleton)

```ts
const appConfig = define('app-config', {
  schema: {
    siteName: Str({ required: true }),
    maxNotesPerUser: Int(),
    maintenanceMode: Bool(),
  },
  storage: Singleton(),
});

const appConfigParticipation = participate('app-config', {});
```

### PublishedNotes (Derived)

```ts
const publishedNotes = define('published-notes', {
  schema: {
    title: Str({ required: true }),
    authorName: Str(),
    publishedAt: DateTime(),
  },
  storage: Derived({
    source: 'note',
    filter: { status: 'published' },
  }),
});

const publishedNotesParticipation = participate('published-notes', {});
// Only produces 'read' participation (Derived — defaults filter to entity's operation set)
```

### Feed (Persistent, receives reactions)

```ts
const feed = define('feed', {
  schema: {
    message: Str({ required: true }),
    entityRef: Str(),
    timestamp: DateTime({ required: true }),
  },
  storage: Persistent(),
});

const feedParticipation = participate('feed', {
  actions: {
    notify: {
      handler: async (ctx) => {
        const event = ctx.input as DomainEvent;
        await ctx.store.create('feed', {
          message: `New ${event.entity} created`,
          entityRef: `${event.entity}:${event.entityId}`,
          timestamp: new Date().toISOString(),
        });
      },
      kind: 'mutation',
      scoped: false,
      description: 'Create feed notification from event',
    },
  },
});
```

## createProofHarness()

Pre-configured harness with all proof entities:

```ts
async function createProofHarness(config?: {
  enableSubscriptions?: boolean;
  useSqlite?: boolean;
}): Promise<TestHarness>
```

Equivalent to:
```ts
createTestHarness({
  declarations: [
    note, noteParticipation, noteSubscriptions, noteBindings,
    user, userParticipation,
    appConfig, appConfigParticipation,
    publishedNotes, publishedNotesParticipation,
    feed, feedParticipation,
  ],
  defaultIdentity: { id: 'test-admin', roles: ['admin'] },
  enableSubscriptions: config?.enableSubscriptions,
  useSqlite: config?.useSqlite,
});
```

## ProofEntities

Exported as a flat array for consumers who want to compose with additional declarations:

```ts
const ProofEntities: readonly DeclarationRecord[] = [
  note, noteParticipation, noteSubscriptions, noteBindings,
  user, userParticipation,
  appConfig, appConfigParticipation,
  publishedNotes, publishedNotesParticipation,
  feed, feedParticipation,
];
```

## Integration test scenarios

The proof harness should enable (and the testing gate requires) these end-to-end scenarios:

### CRUD lifecycle
1. Create a note → 201, record returned with generated id, status='draft'
2. Read the note by id → 200, record matches
3. Read all notes → 200, page with 1 record
4. Update the note title → 200, updated record
5. Delete the note → 204

### Lifecycle transitions
1. Create a note (draft)
2. Update with status='published' → succeeds (draft→published is legal)
3. Update with status='draft' → fails (published→draft is not legal)
4. Update with status='archived' → succeeds (published→archived is legal)

### Policy enforcement
1. Admin creates note → succeeds
2. User reads note → succeeds (anonymousRead or user has read)
3. Anonymous reads note → succeeds (anonymousRead: true)
4. Anonymous creates note → fails (forbidden)
5. User creates note → succeeds (user has create)
6. User updates another user's note → fails (ownership enforcement)

### Invariant enforcement
1. Create note with empty title → fails (invariant: title-not-empty)
2. Create note with valid title → succeeds

### Audit trail
1. Create a note → `execution_log` has 1 entry with handler='audit-relational', event='created', before=null
2. Update the note → `execution_log` has 2 audit entries, second with before/after in payload
3. Delete the note → `execution_log` has 3 audit entries, third with event='deleted'

### Observation
1. Create a note → `execution_log` has entry with handler='observe-memory' (Created is in observe config)
2. Delete the note → no new observe entry in `execution_log` (Deleted not in observe config)

### Custom action
1. Create a note, then dispatch 'note:pin' → note record has pinned=true

### Subscription/reaction
1. Enable subscriptions
2. Create a note → feed entity gets a 'notify' record (reaction fires)

### Singleton
1. Read app-config → returns default record
2. Update app-config → returns updated record
3. No create or delete operations available

### Derived
1. Create notes in draft and published states
2. Read published-notes → only published notes returned

## Testing gate

When 124-11 is implemented, the following should be testable:

- `createTestHarness({ declarations: [...] })` compiles and returns working harness
- `createProofHarness()` returns harness with all proof entities
- All integration test scenarios listed above pass
- `harness.events` captures domain events for assertions
- `harness.resetEvents()` clears captured events
- `harness.seed()` inserts records bypassing pipeline
- `harness.shutdown()` cleans up
- Proof entities exercise: Persistent, Singleton, Derived, Volatile storage; lifecycle; relations; audit; observe; policy; invariant; actions; subscriptions; bindings
