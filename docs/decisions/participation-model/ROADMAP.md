# ADR-124 Implementation Roadmap

**Purpose:** Build order for packages/next-next, organized around a dogfooding demo app that tracks its own development. Each milestone produces a testable, usable increment.

**Companion to:** [index.md](index.md) (architecture), sub-ADRs 00–13 (specifications)

**Demo database:** SQLite (file-based, persists across sessions, no server process)

**Demo location:** `packages/dev/` — the entities, participation, and CLI that exercise the framework

---

## Demo App: Janus Development Tracker

Four entities that exercise the core framework capabilities: CRUD, lifecycles, relations, search, audit.

```ts
import { define, participate, subscribe, bind, compile } from '@janus/core';
import { Str, Int, Markdown, DateTime, Enum, Lifecycle, Relation, Persistent } from '@janus/vocabulary';

// ── Entity definitions ──────────────────────────────────────────────

const adr = define('adr', {
  schema: {
    number: Int({ required: true }),
    title: Str({ required: true }),
    summary: Markdown(),
    status: Lifecycle({
      states: ['draft', 'accepted', 'implemented', 'superseded'],
      initial: 'draft',
      transitions: {
        draft: ['accepted'],
        accepted: ['implemented', 'superseded'],
        implemented: ['superseded'],
      },
    }),
    depends_on: Relation('adr'),
  },
  storage: Persistent(),
  description: 'Architecture decision records for the framework',
});

const task = define('task', {
  schema: {
    title: Str({ required: true }),
    description: Markdown(),
    adr: Relation('adr'),
    assignee: Str(),
    priority: Enum(['low', 'medium', 'high']),
    status: Lifecycle({
      states: ['pending', 'in_progress', 'completed', 'blocked'],
      initial: 'pending',
      transitions: {
        pending: ['in_progress', 'blocked'],
        in_progress: ['completed', 'blocked', 'pending'],
        blocked: ['pending', 'in_progress'],
      },
    }),
  },
  storage: Persistent(),
  description: 'Implementation tasks linked to ADRs',
});

const test_run = define('test_run', {
  schema: {
    suite: Str({ required: true }),
    passed: Int({ required: true }),
    failed: Int({ required: true }),
    skipped: Int(),
    duration: Int(),
    commit: Str(),
    timestamp: DateTime({ required: true }),
  },
  storage: Persistent(),
  description: 'Test suite execution records',
});

const question = define('question', {
  schema: {
    title: Str({ required: true }),
    context: Markdown(),
    resolution: Markdown(),
    status: Lifecycle({
      states: ['open', 'resolved', 'deferred'],
      initial: 'open',
      transitions: { open: ['resolved', 'deferred'], deferred: ['open'] },
    }),
    adr: Relation('adr'),
  },
  storage: Persistent(),
  description: 'Open design questions linked to ADRs',
});

// ── Participation ───────────────────────────────────────────────────

participate(adr, { audit: AuditFull });
participate(task, { audit: AuditFull });
participate(test_run, {});  // defaults only — no audit needed for test records
participate(question, { audit: AuditFull });

// ── Subscriptions (Milestone 7) ─────────────────────────────────────

subscribe(task, [
  // When all tasks for an ADR complete, auto-accept the ADR
  { on: Updated, handler: 'dispatch-adapter',
    config: { entity: 'adr', action: 'check_completion' } },
]);

// ── Compile ─────────────────────────────────────────────────────────

const registry = compile([
  adr, task, test_run, question,
  // ... participation, subscription, binding results
]);
```

**What this exercises:**
- `define()` with Persistent storage, Lifecycle fields, Relation fields, Enum, Markdown
- `participate()` with defaults and audit configuration
- `subscribe()` with event-triggered dispatch
- `compile()` producing a dispatch-ready registry
- SQLite persistence with lifecycle transitions
- Relation wiring (task → adr, question → adr, adr → adr)

---

## Milestones

### M1: Hello Entity

**ADRs:** [00](00-vocabulary.md), [01](01-core-records-and-define.md), [02](02-wiring-functions.md), [03](03-compile-and-dispatch-index.md)

**What gets built:**
- Type constructors (import unchanged from `@janus/vocabulary`)
- Simplified Operation (4 literals) and EventDescriptor (4 kinds)
- `define()` → frozen GraphNodeRecord
- `deriveOperations()` from storage + schema
- `handler()` registration in runtime registry
- `participate()` with implicit defaults (parse, validate, CRUD handlers, emit, respond)
- `compile()` → CompileResult with dispatch_index

**What gets ported from packages/next:**
- Vocabulary types (unchanged import)
- Schema scanning (lifecycles, wiring fields, classification)
- Storage strategy type guards
- Route derivation logic (simplified to `deriveOperations()`)

**Acceptance:**
- [ ] Demo entities compile without error
- [ ] dispatch_index contains correct (system, entity, operation) pipelines
- [ ] Each pipeline has correct handler order (parse=20, validate=25, store-*=35, emit=40, respond=70)
- [ ] Lifecycle transitions produce correct transitionTargets
- [ ] Relation fields produce correct wiringFields
- [ ] Entity name validation rejects invalid names

**Tests target:** ~80 tests (type constructors, define, participate, compile)

---

### M2: Hello Dispatch

**ADRs:** [04](04-store-adapters-and-crud.md) (partial — SQLite + memory adapters), [05](05-pipeline-concern-adapters.md) (partial — parse, validate, respond), [06](06-dispatch-runtime.md)

**What gets built:**
- `EntityStore` interface with unified `read()` (browse+get merged)
- SQLite adapter (port from packages/next, Kysely-based)
- Memory adapter (port from packages/next)
- `persist_routing` generation during compile
- CRUD handler implementations (store-read, store-create, store-update, store-delete)
- Pipeline concern adapters: schema-parse, schema-validate, respond-shaper
- `createDispatchRuntime()` — pipeline execution with preTx/tx/postTx partitioning
- Re-entrant dispatch (`_dispatch` for handler-to-handler calls)

**What gets ported from packages/next:**
- SQLite adapter (Kysely integration, table creation, CRUD operations)
- Memory adapter
- Parse step logic (type coercion, required field checking)
- Validate step logic (lifecycle transition checking)
- TransactionPipeline execution shape

**Acceptance:**
- [ ] `dispatch('task', 'create', { title: 'Test', status: 'pending' })` persists to SQLite
- [ ] `dispatch('task', 'read', {})` returns all tasks
- [ ] `dispatch('task', 'read', { id: '...' })` returns single task
- [ ] `dispatch('task', 'update', { id: '...', status: 'in_progress' })` validates lifecycle transition
- [ ] Invalid lifecycle transition (pending → completed) is rejected
- [ ] Required field missing on create is rejected
- [ ] Unknown fields are stripped
- [ ] SQLite database file persists between process restarts

**Tests target:** ~120 tests (store adapters, CRUD handlers, dispatch runtime, pipeline execution)

---

### M3: Hello CLI

**ADRs:** [13](13-external-agent-integration.md) (partial — CLI only)

**What gets built:**
- `janus` CLI binary (Bun script)
- Boot sequence: compile demo entities → create SQLite store → create dispatch runtime
- Commands: `read`, `create`, `update`, `delete`, `dispatch`, `operations`, `fields`
- JSON output for agent consumption, table output for human consumption
- SQLite database at `dev/janus.db` (persists across sessions)

**CLI interface:**
```bash
# CRUD
janus read task                              # list all tasks
janus read task --where status=pending       # filtered list
janus read task --id abc123                  # single record
janus create task --title "Implement X"      # create with fields
janus update task --id abc123 --status in_progress  # update fields
janus delete task --id abc123               # delete

# Dispatch (explicit operation, for custom actions)
janus dispatch adr:accept --id abc123       # lifecycle transition

# Discovery
janus operations task                       # list available operations
janus fields task                           # list fields with types
janus entities                              # list all entities

# Output control
janus read task --json                      # JSON output (for agents)
janus read task --table                     # table output (for humans, default)
```

**Acceptance:**
- [ ] `janus create task --title "First task"` creates a record in SQLite
- [ ] `janus read task` shows the created record
- [ ] `janus update task --id <id> --status in_progress` transitions lifecycle
- [ ] `janus operations task` lists: read, create, update, delete + transitions
- [ ] `janus entities` lists: adr, task, test_run, question
- [ ] Database persists between CLI invocations
- [ ] JSON output is parseable by agents
- [ ] Claude Code can run CLI commands and parse results

**Tests target:** ~30 tests (CLI parsing, boot, output formatting)

**Inflection point:** From this milestone onward, Claude Code uses the CLI to track its own work. Every subsequent milestone is recorded as tasks in the demo app.

---

### M4: Hello Audit

**ADRs:** [01b](01b-record-metadata-ownership-scoping.md), [04b](04b-append-storage-and-execution-log.md), [05](05-pipeline-concern-adapters.md) (complete)

**What gets built:**
- Framework-managed metadata columns: createdAt, createdBy, updatedAt, updatedBy, version, deletedAt
- Soft delete support
- Optimistic concurrency via version field
- `execution_log` entity with Append() payload column
- File rotation for append files (monthly)
- Per-row retention on execution_log
- Full pipeline concerns: policy-lookup, rate-limit-check, invariant-check, emit-broker, audit-relational, observe-memory
- Broker (in-process notification, carried forward from packages/next)

**Acceptance:**
- [ ] Created records have createdAt/createdBy automatically set
- [ ] Updated records have updatedAt/updatedBy automatically set
- [ ] `janus read execution_log --where handler=audit-relational` shows audit trail
- [ ] `janus read execution_log --where "source=task"` shows all task-related executions
- [ ] Concurrent update with stale version is rejected
- [ ] Soft-deleted records are excluded from default reads
- [ ] Append file exists at `dev/logs/execution_log/YYYY-MM.jsonl`

**Tests target:** ~80 tests (metadata, execution_log, audit, observe, emit, broker)

---

### M5: Hello Search

**ADRs:** [01c](01c-query-field-and-search.md)

**What gets built:**
- `query_field` Derived entity (per-field operator records)
- Operator sets per semantic type (Str: eq/neq/contains/startsWith, Int: eq/neq/gt/gte/lt/lte, etc.)
- Filtered reads with typed operators
- CLI gets richer query syntax

**Acceptance:**
- [ ] `janus fields task` shows field names, types, and available operators
- [ ] `janus read task --where "priority=high AND status!=completed"` works
- [ ] `janus read adr --where "status=draft"` works
- [ ] `janus read test_run --where "failed>0"` works
- [ ] query_field entity is browseable via `janus read query_field --where entity=task`

**Tests target:** ~40 tests (query_field derivation, operator application, compound filters)

---

### M6: Hello HTTP

**ADRs:** [08](08-http-surface-and-bootstrap.md)

**What gets built:**
- Hono HTTP surface (api_surface initiator)
- HTTP transport adapters: http-receive, http-identity (API key for demo), http-respond
- Route derivation from dispatch_index → Hono route table
- `createApp()` bootstrap (compile → store → runtime → HTTP server)
- `apiSurface()` convenience constructor

**Acceptance:**
- [ ] `GET /api/task` returns task list
- [ ] `POST /api/task` creates a task
- [ ] `PATCH /api/task/:id` updates a task
- [ ] `DELETE /api/task/:id` deletes a task
- [ ] `POST /api/adr/:id/accept` triggers lifecycle transition
- [ ] API key authentication works
- [ ] Errors return structured JSON with correlationId
- [ ] CLI can be reimplemented as thin HTTP client (optional)

**Tests target:** ~60 tests (HTTP surface, route derivation, transport adapters, createApp)

---

### M7: Hello Subscriptions

**ADRs:** [07](07-subscriptions-broker-scheduler.md), [07b](07b-tracked-subscriptions-dead-letter.md)

**What gets built:**
- SubscriptionRecord, subscribe()
- Subscription processor (event-triggered)
- Scheduler (cron-triggered)
- dispatch-adapter subscription handler
- Tracked subscriptions with execution_log status progression
- Dead-letter as status='dead' on execution_log

**Demo subscriptions:**
- Task completion checks ADR progress (event → dispatch)
- Nightly stale task report (cron → dispatch)

**Acceptance:**
- [ ] Creating a note triggers a subscription that dispatches to another entity
- [ ] Cron subscription fires on schedule
- [ ] Tracked subscription writes running/completed/failed rows to execution_log
- [ ] Dead-lettered work queryable via `janus read execution_log --where status=dead`

**Tests target:** ~50 tests (subscribe, broker, scheduler, tracked subscriptions, dead-letter)

---

### M8: Hello Binding

**ADRs:** [10](10-presentation-and-binding.md), [12a](12a-connection-protocol-and-sync.md), [12b](12b-client-entity-cache.md)

**What gets built:**
- BindingRecord with component references and field metadata
- bind() → binding index
- BindingContext / FieldState with @preact/signals-core
- Preact components for demo entities (task list, task detail, ADR dashboard)
- Connection entity (SSE)
- Sync protocol (server → client events)
- Hono SSR + hydration
- Client-side navigation

**Acceptance:**
- [ ] Web UI at `localhost:3000` shows task list
- [ ] Clicking a task shows detail view with editable fields
- [ ] ADR dashboard shows status counts
- [ ] Changes in one tab appear in another (SSE sync)
- [ ] Field-level dirty tracking works (edit without save shows unsaved indicator)

**Tests target:** ~60 tests (binding, signals, SSR, connection, sync)

---

### M9: Hello Agent Surface

**ADRs:** [09](09-agent-surface-and-session.md)

**What gets built:**
- Agent surface with tool discovery from dispatch_index
- Session entity (volatile, per-user)
- Agent interaction levels on binding contexts
- buildAgentContext() from session + binding + graph_node

**Acceptance:**
- [ ] Agent can discover available operations via dispatch_index query
- [ ] Agent can read/write field values through binding context signals
- [ ] Session tracks what the user is looking at
- [ ] Agent interaction levels (read-write/read/aware) are enforced

**Tests target:** ~40 tests (agent surface, session, tool discovery)

---

## Deferred (not needed for dogfooding)

| ADR | Why deferred | When to revisit |
|-----|-------------|-----------------|
| [01d](01d-wiring-effects-cross-entity-lifecycle.md) | Cascade/restrict effects — demo entities don't need cross-entity lifecycle | After M7 (subscriptions handle the demo's cross-entity logic) |
| [04c](04c-schema-reconciliation.md) | Schema migration — manual `rm janus.db` works for the demo | When the demo database has real data worth keeping |
| [07c](07c-connectors.md) | External system integration — no external systems in the demo | When a real consumer app needs connectors |
| [08b](08b-assets-and-media.md) | File uploads — no binary assets in the demo | When the demo or a consumer needs media |
| [10b](10b-template-column-type-and-rendering.md) | Template rendering — no notifications in the early demo | When M7 subscriptions need rendered output |

---

## Build Dependencies

```
M1 (Entity)
 ↓
M2 (Dispatch)
 ↓
M3 (CLI) ←── inflection: Claude Code starts using the app
 ↓
M4 (Audit) ←── parallel with M5
 ↓
M5 (Search)
 ↓
M6 (HTTP)
 ↓
M7 (Subscriptions) ←── parallel with M8
 ↓
M8 (Binding)
 ↓
M9 (Agent Surface)
```

M4 and M5 can proceed in parallel (audit and search are independent).
M7 and M8 can partially overlap (subscriptions don't depend on binding).

---

## Package Structure

```
packages/
  core/                    # define, participate, subscribe, bind, compile
    __tests__/
  store/                   # EntityStore, adapters (sqlite, memory)
    __tests__/
  pipeline/                # dispatch runtime, concern adapters
    __tests__/
  cli/                     # janus CLI binary
    __tests__/
  http/                    # Hono integration, HTTP surface
    __tests__/
  client/                  # Preact, signals, SSR, connection
    __tests__/
  dev/                     # Dev app entities + configuration
    entities.ts            # adr, task, test_run, question
    participation.ts       # pipeline wiring for demo entities
    subscriptions.ts       # event/cron wiring
    bindings.ts            # component bindings (M8+)
    app.ts                 # bootstrap (compile + createApp)
    janus.db               # SQLite database (gitignored)
    logs/                  # Append files (gitignored)
  testing/                 # createTestHarness, proof entities
    __tests__/
```

---

## Tracking

Once M3 is complete, milestones and tasks are tracked in the demo app itself:

```bash
janus create task --title "M4: Implement framework-managed metadata" --adr 124 --priority high
janus create task --title "M4: Implement execution_log entity" --adr 124 --priority high
janus create task --title "M4: Implement audit concern adapter" --adr 124 --priority medium
# ...
```

Until then, tracking lives in this document and in Claude Code's conversation context.
