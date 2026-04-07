# Janus Framework

## Overview

Janus is a **meta-harness** — it organizes domain knowledge and makes it navigable by any agent runtime. It does not run agents; it makes domains agent-navigable. See `docs/philosophy/meta-harness.md` for the full philosophy.

**The bet:** Domain knowledge, permissions, and self-description are durable value. Agent reasoning, tool orchestration, and context management are increasingly model-native. Build what persists. The entity graph is the single source of truth — every surface (CLI, HTTP, MCP, SSE, voice) is a derived projection. The domain is the constant; the agent is the variable.

An application is a graph of entities. Entity definitions, operations, lifecycles, storage strategies, and relations compile into a registry that the pipeline dispatches against, agents discover tools from, and transport surfaces project.

## Packages

| Package | Responsibility |
|---------|---------------|
| `@janus/vocabulary` | Semantic types, classifications, storage strategies, wiring types |
| `@janus/core` | `define()`, `participate()`, `subscribe()`, `bind()`, `compile()`, types, handler registry, invariant helpers |
| `@janus/store` | `EntityStore` interface, memory + SQLite + PostgreSQL adapters, FTS5, schema migration |
| `@janus/pipeline` | `createDispatchRuntime()`, all concern handlers, broker, subscriptions, framework entities, connection manager, SSE bridge |
| `@janus/client` | `FieldState`, `BindingContext`, `BindingRegistry`, serialize/deserialize, SSE→signal bridge, dispatch helper (`@preact/signals-core`) |
| `@janus/http` | Hono HTTP surface, route derivation, SSR with Preact, SSE endpoint |
| `@janus/agent` | Agent surface, session context, tool discovery, Claude/OpenAI integration |
| `@janus/calendar` | RRULE expansion, iCal serialize/parse, availability checking — pure calendar domain knowledge |
| `@janus/testing` | `createTestHarness()`, proof entities |
| `@janus/cli` | `janus` CLI binary — read/create/update/delete/dispatch/search |

Dependency flow: `vocabulary` → `core` → `store` / `pipeline` / `client` / `calendar` → `http` / `agent` / `cli`.

Examples: `examples/dev-app/` — development app with entity definitions, seed script, and Preact components.

## Core idea

Four consumer functions (`define`, `participate`, `subscribe`, `bind`). Four CRUD operations (`read`, `create`, `update`, `delete`).

An entity defines its data identity (`define()`). Infrastructure participation is declared separately (`participate`, `actions`, `subscribe`, `bind`). Everything compiles into records. The dispatch pipeline is assembled by joining an initiator's participation records with the target entity's participation records — one flat, sorted, frozen pipeline per `(initiator, entity, operation)` triple.

## Pipeline concern handlers

| Handler | Order | Tx | What it does |
|---------|-------|------|-------------|
| `policy-lookup` | 10 | no | Hash-map rule evaluation from PolicyConfig |
| `rate-limit-check` | 11 | no | Counter check against limits |
| `schema-parse` | 20 | no | Coerce input, strip unknowns, check required |
| `schema-validate` | 25 | no | Lifecycle transition checking, before-record fetch |
| `invariant-check` | 26 | no | Predicate functions against proposed state |
| `credential-generate` | 30 | no | Auto-generate Token and QrCode values on create |
| `store-read/create/update/delete` | 35 | varies | Core CRUD against EntityStore |
| `emit-broker` | 40 | yes | Notify broker |
| `audit-relational` | 50 | yes | Write before/after snapshots to execution_log |
| `observe-memory` | 50 | no | Write observation records to execution_log |
| `respond-shaper` | 70 | no | Shape dispatch result |

## Commands

```bash
# Dependencies
bun install

# Tests
bun test packages/                    # Run all tests (1154 tests)
bun test packages/core/               # Single package
bun test --watch packages/            # Watch mode

# Code quality
bun run typecheck                     # TypeScript check
bun run lint                          # Biome linting
bun run lint:fix                      # Auto-fix lint issues
bun run format                        # Format code

# Dev app
bun run janus <command>               # Run the janus CLI
bun run janus:seed                    # Re-seed the dev database
```

### The janus CLI

The dev app tracks framework development in a SQLite database (`examples/dev-app/janus.db`).

```bash
# Entity discovery
bun run janus entities
bun run janus operations task
bun run janus fields task

# CRUD
bun run janus read task
bun run janus read task --id <id>
bun run janus create task --title "Implement X" --priority high
bun run janus update task --id <id> --status in_progress
bun run janus delete task --id <id>

# Lifecycle transitions
bun run janus dispatch task:completed --id <id>

# Full-text search
bun run janus read task --search "calendar"

# JSON output
bun run janus read task --json
```

## Key principles

- **Relation is the universal connector.** Everything wires through Reference edges in the entity graph.
- **Handler() is the function connector.** Pipeline and subscription behavior resolves from a runtime registry.
- **Four CRUD operations.** `read`, `create`, `update`, `delete`. Each is a handler at order=35.
- **Initiator join model.** Pipeline = `sort(initiator.participation ∪ entity.participation(operation))`.
- **Compile is pure.** Stateless function from records → dispatch-index records.
- **Order, not phase.** Integer ordering on participation records. `transactional` flag determines tx boundaries.

## Development Rules

### Facade Imports Only

Always use facade imports (`@janus/core`, `@janus/vocabulary`, etc.). Never import from internal package paths.

### Testing

Every package has `__tests__/` colocated with source. Integration tests that cross package boundaries go in the downstream package's `__tests__/`.

Standard test pattern: `clearRegistry()` → `registerHandlers()` → define entities → participate → compile → create store → initialize → create dispatch runtime → dispatch operations.

### Entity naming

All entity names use underscores: `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`. Max 64 characters. Directly usable as SQL table names. Framework vs consumer distinguished by `origin` field, not naming convention.

### Schema migration

The SQLite adapter auto-migrates on initialize: compares compiled schema against existing table via `PRAGMA table_info`, runs `ALTER TABLE ADD COLUMN` for new fields. Removals are warned but not auto-dropped.

### Hard Non-Negotiables

- Money in cents; percentages in basis points
- Do not bypass auth, role checks, or ownership checks
- Never expose `YOUTH_SENSITIVE` data publicly
- Prevent cross-user data leakage
- Treat AI output as untrusted input at schema boundaries

## Domain knowledge batteries

The framework ships domain knowledge — types, validation, temporal math, and interop — that anyone building in a given area needs:

**Credentials:** `Token()` and `QrCode()` semantic types with auto-generation on create (`credential-generate` concern), configurable character sets, prefix/length, expiry management (companion `_fieldExpiresAt` columns), and `/verify/:code` HTTP route for cross-entity QrCode lookup.

**Calendar:** RRULE expansion (WEEKLY/DAILY/MONTHLY/YEARLY), iCal serialize/parse (RFC 5545), availability checking (windows, blackouts, lead time, horizon, conflict detection). Currently pure functions in `@janus/calendar`; entity-first integration planned in [ADR 15](docs/decisions/participation-model/15-calendar-domain-entities.md).

**Temporal invariants:** `TimeGate(field, duration, opts)` enforces datetime constraints. `FieldCompare(fieldA, op, fieldB)` asserts relationships between fields. `Hours()`, `Days()`, `Minutes()` duration helpers.

## Source of Truth

1. This `CLAUDE.md`
2. `docs/philosophy/meta-harness.md` — meta-harness philosophy
3. `docs/decisions/participation-model/` — architecture (22 sub-documents)
4. `docs/decisions/participation-model/ROADMAP.md` — milestones and build order
5. `docs/decisions/participation-model/14-end-to-end-narrative.md` — PCA cleanup event walkthrough
6. `docs/philosophy/type-philosophy.md`
7. Working code in `packages/` (1154 tests)
