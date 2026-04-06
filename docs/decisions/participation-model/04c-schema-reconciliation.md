# 124-04c: Schema Reconciliation & Evolution

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [01b](01b-record-metadata-ownership-scoping.md) (Record Metadata), [04](04-store-adapters-and-crud.md) (Store Adapters), [04b](04b-append-storage-and-execution-log.md) (Append Storage)
**Amends:** [01](01-core-records-and-define.md) (DefineConfig — `evolve` field), [04](04-store-adapters-and-crud.md) (StoreAdapter — `reconcile()`, RoutingRecord — `evolve` field), [08](08-http-surface-and-bootstrap.md) (bootstrap sequence)

## Scope

This sub-ADR specifies:
- The **policy layer** for schema evolution: change classification, auto-apply rules, and consumer disambiguation via `evolve` config
- How the v1 snapshot/diff engine and Kysely's schema infrastructure are composed into a reconciliation pipeline
- Bootstrap integration: where reconciliation runs, how failures surface, and the production plan/apply workflow

This sub-ADR does NOT cover:
- Data migration ETL (bulk value transformations) — that's an application concern, modelable as a custom action
- Cross-entity migration coordination (rename/split/merge entities) — graph-level changes, not schema changes
- DDL generation details — Kysely's `SchemaModule` handles dialect-aware DDL

## Existing infrastructure

The framework already has the moving parts for schema evolution. They've never been composed into a policy.

### V1 snapshot and diff engine

`packages/store/postgres/migrate/` provides:

- **`GraphSnapshot` / `FieldSnapshot`** (`snapshot.ts`) — Captures the full semantic schema per entity: field names, kinds (semantic/lifecycle/relation/ref/enum), SQL types, semantic types, lifecycle states, wiring targets, index/unique flags. Serializable to JSON.
- **`createGraphSnapshot(graph, version)`** — Walks the compiled graph, classifies each field via `classifyField()`, produces a snapshot.
- **`generateMigration(from, to)`** (`migrate.ts`) — Diffs two snapshots. Produces `MigrationAction[]` with `kind` (create_table, drop_table, add_column, drop_column, alter_check, add_index, review), raw SQL, description, and `destructive` flag.
- **`generateDDL(graph)`** (`ddl.ts`) — Full DDL from scratch, including topological sort for dependency ordering.

`packages/next/store/schema-gen.ts` provides a simpler version: `generateMigrationDdl(entity, existingColumns)` that returns `{ adds, drops }` by diffing compiled entity schema against existing column names.

**What carries forward:** The snapshot concept, field classification, and semantic-level diffing. The types and functions will be ported to use next-next's `GraphNodeRecord` and vocabulary instead of v1's `Graph`/`Entity`.

**What changes:** Raw SQL strings are replaced with Kysely's schema builder. The `MigrationAction.destructive` flag is replaced with the four-tier classification (see Decision 2).

### Kysely infrastructure (0.28, currently used only as query builder)

- **`SchemaModule`** (`db.schema`) — Dialect-aware DDL builder. `alterTable().addColumn()`, `.dropColumn()`, `.renameColumn()`, `.alterColumn()`, `createIndex()`, `dropIndex()`. Handles Postgres vs SQLite DDL differences automatically.
- **`DatabaseIntrospector`** (`db.introspection`) — Reads current table metadata: `getTables()` returns `TableMetadata[]` with column names, SQL types, nullability, defaults. Available for all dialects.

**What we use:** `SchemaModule` for all DDL execution (no more raw SQL strings). `DatabaseIntrospector` as a safety check during reconciliation — verify the actual database state matches the stored snapshot before applying changes.

**What we don't use:** `Migrator` / `FileMigrationProvider`. Kysely's migration system is designed for named, file-based up/down migrations. Janus computes migrations from the graph diff — there are no named migration files. The snapshot-based approach is more natural for computed migrations.

## Problem

The framework owns `define()` → `compile()` → `persist_routing` → `StoreAdapter.initialize()`. First-run bootstrap works — `initialize()` creates tables. But on subsequent runs, when the schema has changed, `initialize()` has no model for the delta.

V1's `generateMigration()` can compute the delta and has a `destructive` flag, but it applies ALL changes without consumer input. There's no mechanism to:
- Block destructive changes until explicitly acknowledged
- Disambiguate a rename from a drop + add
- Require a backfill value for new required columns
- Map lifecycle state removals to replacement states

The gap isn't diffing or DDL — those exist. The gap is the **policy** between "the framework computed a schema delta" and "the framework applied it."

## Decision

### 1. Reconciliation pipeline

Schema reconciliation composes three existing pieces with a new policy layer:

```
reconcile(desired: RoutingRecord[], db: Kysely):
  1. Read snapshot    — _janus_schema rows for each entity (evolved v1 GraphSnapshot)
  2. Diff             — compare desired vs snapshot per entity (evolved v1 generateMigration)
  3. Classify         — apply the four-tier policy to each change           ← NEW
  4. Resolve          — match evolve hints against classified changes       ← NEW
  5. Apply            — execute safe + resolved changes via db.schema       (Kysely SchemaModule)
  6. Update snapshot  — write new snapshot (in the same transaction as DDL)
  7. Report           — return applied + blocked changes                    ← NEW
```

Steps 1-2 are evolved from v1. Step 5 uses Kysely. Steps 3-4 and 6-7 are the new policy layer.

### 2. Change classification

V1's `MigrationAction` has a boolean `destructive` flag. This is too coarse — some non-destructive changes still need consumer input (add required column), and some destructive changes are fine if acknowledged. The classification expands to four tiers:

#### Safe — auto-applied, no consumer input needed

| Change | Why safe |
|--------|----------|
| Add nullable column | Existing records unaffected; defaults to NULL |
| Add lifecycle state | Existing records keep their state; new state is reachable |
| Add wiring field (nullable) | Same as add nullable column |
| Add/remove index | Read performance only; no data impact |
| New entity (CREATE TABLE) | No existing data |
| Add transition | Existing states gain new outbound edges |
| Required → nullable | Relaxes constraint; no data changes |

#### Cautious — auto-applied IF consumer provides a backfill

| Change | What's needed | Why |
|--------|--------------|-----|
| Add required column | `evolve.backfills` entry with default value | Existing rows need a value |
| Nullable → required | `evolve.backfills` entry for NULL rows | Existing NULLs violate the constraint |
| Add `owned: true` | `evolve.backfills` for `ownerId` | Existing rows have no owner |

#### Destructive — blocked unless explicitly acknowledged

| Change | Resolution | Why |
|--------|-----------|-----|
| Remove column | `evolve.drops` lists the field name | Data loss is irreversible |
| Remove entity | top-level `drop()` declaration | Table drop is irreversible |
| Remove `owned: true` | `evolve.drops` lists `'ownerId'` | Ownership data is discarded |
| Persistent → Volatile | top-level `drop()` declaration | Persistent data abandoned |
| Persistent → Derived | top-level `drop()` declaration | Storage replaced by computation |

#### Ambiguous — blocked unless disambiguated

| Change pattern | Possible interpretations | Resolution |
|---------------|------------------------|------------|
| Column A removed + column B added (same type) | Rename A→B, or drop A + add B | `evolve.renames` maps A→B, or `evolve.drops` lists A |
| Remove lifecycle state | Records may be in that state | `evolve.stateMap` maps removed state → replacement |

**Type changes** (`change-type` in the diff) are always classified as ambiguous. The consumer must provide `evolve.coercions` with a transform function. This is intentionally conservative — silent type coercion is a data integrity risk.

**Rename heuristic.** When one column disappears and one appears with the same semantic type, the adapter flags it as a potential rename. If multiple columns disappear and appear simultaneously, all are flagged as ambiguous — the adapter does not try to pair them. The consumer disambiguates with explicit `evolve.renames` and/or `evolve.drops`.

**Wiring target changes** (e.g., `author: Relation('user')` → `author: Relation('person')`) are classified as ambiguous — existing foreign key values may reference the wrong entity. The consumer must provide `evolve.coercions` or `evolve.drops`.

**Transition changes** (removing a transition from the lifecycle map) are safe at the storage level — no DDL needed. The validate concern enforces the updated transition map at dispatch time.

### 3. EvolveConfig on define()

`DefineConfig` gains an optional `evolve` field for consumer disambiguation of non-auto-resolvable changes:

```ts
interface DefineConfig {
  readonly schema: Record<string, SchemaField>;
  readonly storage: StorageStrategy;
  readonly description?: string;
  readonly owned?: boolean;
  readonly evolve?: EvolveConfig;  // NEW
}

interface EvolveConfig {
  // Column renames: old field name → new field name
  readonly renames?: Readonly<Record<string, string>>;

  // Default values for new required columns or NULL backfill
  readonly backfills?: Readonly<Record<string, unknown>>;

  // Explicit acknowledgment of column drops (data loss)
  readonly drops?: readonly string[];

  // Type coercions: field name → transform function
  // The adapter calls this per-row to convert the old value to the new type.
  // For bulk data, the adapter generates a single UPDATE with a CASE expression.
  readonly coercions?: Readonly<Record<string, (old: unknown) => unknown>>;

  // Lifecycle state mapping: field name → { removed state → replacement state }
  readonly stateMap?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

**`coercions` uses functions, not SQL.** V1 used raw SQL strings (`ALTER TABLE ... ALTER COLUMN ... TYPE ...`). This leaks dialect details into `define()`. Instead, the consumer provides a JavaScript function. The adapter translates it to the appropriate DDL — for the relational adapter, it reads all affected rows, applies the function, and writes back via `UPDATE`. This keeps `define()` dialect-agnostic.

**`evolve` is ephemeral.** Once the migration is applied, the config can be removed. The snapshot records the applied schema, so subsequent bootstraps see no diff. Stale `evolve` config is silently ignored — the diff doesn't contain those changes, so the hints have nothing to resolve.

**Examples:**

```ts
// Rename body → content
define('note', {
  schema: { title: Str({ required: true }), content: Str() },
  storage: Persistent(),
  evolve: { renames: { body: 'content' } },
});

// Add required tags field with backfill
define('note', {
  schema: { title: Str({ required: true }), body: Str(), tags: Arr(Str(), { required: true }) },
  storage: Persistent(),
  evolve: { backfills: { tags: [] } },
});

// Remove deprecated field
define('note', {
  schema: { title: Str({ required: true }), body: Str() },
  storage: Persistent(),
  evolve: { drops: ['legacyField'] },
});

// Lifecycle state removal with mapping
define('note', {
  schema: {
    title: Str({ required: true }),
    status: Lifecycle({
      states: ['draft', 'published', 'archived'],  // 'review' removed
      initial: 'draft',
      transitions: { draft: ['published'], published: ['archived'] },
    }),
  },
  storage: Persistent(),
  evolve: { stateMap: { status: { review: 'draft' } } },
});

// Add ownership to existing entity
define('note', {
  schema: { title: Str({ required: true }), body: Str() },
  storage: Persistent(),
  owned: true,
  evolve: { backfills: { ownerId: 'system' } },
});
```

### 4. Entity removal via drop()

Entity removal can't use `evolve` on `define()` — there's no `define()` call for a removed entity. A top-level `drop()` function provides the acknowledgment:

```ts
const registry = compile([
  define('note', { ... }),
  define('venue', { ... }),

  drop('legacy_entity'),  // acknowledge removal — table left in place, removed from snapshot

  participate('note', { ... }),
  // ...
]);
```

`drop()` produces a `DeclarationRecord` with `kind: 'drop'` that `compile()` processes. The reconciliation pipeline sees the entity in the snapshot but not in the desired state, checks for a matching `drop()` declaration, and either:
- **With `drop()` declaration:** Removes the entity from `_janus_schema`. The database table is left in place for manual recovery. A future cleanup action can remove it.
- **Without `drop()` declaration:** Blocks with an actionable error.

Storage strategy changes that switch adapters (Persistent → Volatile, Persistent → Derived) use the same mechanism — from the old adapter's perspective, the entity is being removed.

### 5. Schema snapshot: evolved _janus_schema

V1's `GraphSnapshot` stores the full semantic schema as serializable JSON. This carries forward as the `_janus_schema` table — the adapter's internal bookkeeping, not a framework entity.

```sql
CREATE TABLE IF NOT EXISTS _janus_schema (
  entity      TEXT PRIMARY KEY,
  snapshot    TEXT NOT NULL,    -- JSON: FieldSnapshot[] (v1 type, ported)
  storage     TEXT NOT NULL,    -- storage strategy name
  owned       INTEGER NOT NULL, -- boolean
  version     TEXT NOT NULL,    -- compile version (from GraphSnapshot.version)
  applied_at  TEXT NOT NULL     -- ISO timestamp
);
```

The `snapshot` column stores the same semantic information as v1's `FieldSnapshot[]` — field names, kinds, semantic types, SQL types, lifecycle states, wiring targets, index flags. This preserves semantic-level diffing that SQL introspection alone can't provide (two different semantic types may compile to the same SQL type).

**Introspection as safety check.** Before applying changes, the adapter calls `db.introspection.getTables()` to verify the actual database state matches the stored snapshot. If they diverge (e.g., someone manually altered the table), the adapter blocks with a warning. This catches drift between the snapshot and reality.

**Snapshot update is transactional.** The `_janus_schema` update runs in the same transaction as the DDL changes for each entity. If DDL fails, the snapshot isn't updated — the next run retries from the same state.

### 6. Framework entity evolution

Infrastructure entities (`graph_node`, `execution`, `participation`, etc.) are framework-seeded, not consumer-defined. They evolve when the framework version changes.

The framework maintains its own snapshots in `_janus_schema` alongside consumer entity snapshots (they share the table — the `entity` column distinguishes them). When the framework upgrades and changes an infrastructure entity's schema, the same reconciliation pipeline runs.

The framework's `evolve` config is internal — defined in the framework's bootstrap code, not exposed to consumers. For example, if a framework upgrade adds a column to the `execution` table, the framework's bootstrap includes the equivalent of `evolve: { backfills: { newField: defaultValue } }` for that release. This is forward-only — the framework doesn't support downgrade.

### 7. DDL via Kysely SchemaModule

V1 generates raw SQL strings for DDL. This is fragile across dialects — Postgres and SQLite have different ALTER TABLE capabilities, different type names, different constraint syntax.

The reconciliation pipeline uses Kysely's `SchemaModule` for all DDL execution:

```ts
// Add nullable column
await db.schema.alterTable(table).addColumn(field, sqlType).execute();

// Add column with default (for backfill)
await db.schema.alterTable(table).addColumn(field, sqlType, col => col.defaultTo(value).notNull()).execute();
// Then: UPDATE to set backfill values; then drop the DEFAULT

// Rename column
await db.schema.alterTable(table).renameColumn(oldName, newName).execute();

// Drop column
await db.schema.alterTable(table).dropColumn(field).execute();

// Create index
await db.schema.createIndex(indexName).on(table).column(field).execute();
```

The adapter maps each classified + resolved change to the appropriate `SchemaModule` calls. This handles dialect differences automatically — `SchemaModule` knows how to ALTER TABLE on Postgres vs SQLite.

**SQLite rebuild strategy.** For changes that SQLite doesn't support natively (DROP COLUMN on older versions, ALTER COLUMN), the adapter uses the standard rebuild: create temp table with new schema, copy data, drop old table, rename. Kysely's `SchemaModule` handles this via the SQLite dialect.

### 8. Per-adapter behavior

| Adapter | Reconciliation behavior |
|---------|------------------------|
| **Relational** | Full reconciliation: snapshot diff → classify → resolve → DDL via SchemaModule |
| **Append** | Index-level reconciliation only. Delegates to relational adapter's logic for the index table. Payload files are schema-less JSON — no migration needed. |
| **Memory** | No-op. Volatile storage rebuilt on restart. |
| **File** | No-op. Records are JSON files — schema-less at storage level. |
| **Derived** | No-op. Records are recomputed. |
| **Virtual** | No-op. External data source. |

### 9. StoreAdapter interface amendment

The `StoreAdapter` in [04](04-store-adapters-and-crud.md) gains `reconcile()`:

```ts
interface StoreAdapter {
  // ... existing methods (read, create, update, delete, etc.) ...

  // NEW — reconcile desired schema against applied schema
  reconcile(entities: readonly AdapterMeta[], db: Kysely<any>): Promise<ReconcileResult>;

  // Existing — create tables/structures for new entities (unchanged)
  initialize(entities: readonly AdapterMeta[]): Promise<void>;

  shutdown(): Promise<void>;
}

interface AdapterMeta {
  readonly entity: string;
  readonly table: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly storage: StorageStrategy;
  readonly owned: boolean;       // from 01b
  readonly evolve?: EvolveConfig; // from define()
}

interface ReconcileResult {
  readonly applied: readonly AppliedChange[];
  readonly blocked: readonly BlockedChange[];
}

interface AppliedChange {
  readonly entity: string;
  readonly description: string;
  readonly classification: 'safe' | 'cautious' | 'destructive';
}

interface BlockedChange {
  readonly entity: string;
  readonly description: string;
  readonly classification: 'cautious' | 'destructive' | 'ambiguous';
  readonly resolution: string;  // what the consumer needs to add to evolve
}
```

`reconcile()` handles existing entities (diff → classify → resolve → apply). `initialize()` handles new entities (CREATE TABLE). The adapter distinguishes the two by checking `_janus_schema` — entity exists in snapshot → reconcile, absent → initialize.

### 10. RoutingRecord amendment

The `RoutingRecord` in [04](04-store-adapters-and-crud.md) carries the evolve config through to the adapter:

```ts
interface RoutingRecord {
  readonly entity: string;
  readonly table: string;
  readonly adapter: 'relational' | 'memory' | 'file' | 'derived' | 'virtual' | 'append';
  readonly schema: Readonly<Record<string, unknown>>;
  readonly storage: StorageStrategy;
  readonly owned: boolean;
  readonly evolve?: EvolveConfig;  // NEW — from define()
}
```

### 11. Bootstrap integration

The reconciliation phase fits into the `createApp()` bootstrap sequence ([08](08-http-surface-and-bootstrap.md)):

```
createApp():
  1. compile() → registry (including persist_routing, drop declarations)
  2. createEntityStore(registry.routing, adapters, db)
     a. Ensure _janus_schema table exists (CREATE TABLE IF NOT EXISTS)
     b. For each adapter:
        - reconcile(assignedEntities, db) → ReconcileResult
        - If blocked changes: throw SchemaReconciliationError
        - initialize(newEntities)
     c. Return EntityStore
  3. Wire pipeline, broker, surfaces (unchanged)
```

`SchemaReconciliationError` includes every blocked change with a resolution message:

```
SchemaReconciliationError: 3 unresolved schema changes

  note: Column 'body' removed → add to evolve.drops: ['body']
         OR column 'body' renamed to 'content' → add to evolve.renames: { body: 'content' }

  note: New required column 'tags' has no default → add to evolve.backfills: { tags: [] }

  event: Lifecycle 'status' lost state 'review' (4 records affected)
         → add to evolve.stateMap: { status: { review: '<valid-state>' } }
```

### 12. Production workflow

**Development (default):** `createApp()` runs reconciliation automatically. Safe changes apply silently. Blocked changes fail fast with actionable errors.

**Production:** Separate planning from execution:

```ts
import { planReconciliation, applyReconciliation } from '@janus-next/store';

// Step 1: Plan (read-only — no DDL)
const plan = await planReconciliation(registry, db);
// plan: ReconcileResult with applied=[] (nothing applied yet), blocked=[...], pending=[...]

// Step 2: Review
console.log(plan.summary());

// Step 3: Apply
await applyReconciliation(plan, db);

// Step 4: Bootstrap (skip reconciliation — already applied)
const app = await createApp({ ..., reconciliation: 'skip' });
```

`planReconciliation()` runs steps 1-4 of the reconciliation pipeline (read snapshot → diff → classify → resolve) without executing DDL. `applyReconciliation()` executes steps 5-6 (DDL + snapshot update). Both use the same Kysely instance.

### 13. Reconciliation is idempotent

- Running reconciliation twice with the same desired schema produces no changes on the second run — the snapshot matches, the diff is empty.
- Stale `evolve` config is silently ignored — the diff doesn't contain those changes.
- Partial failure (crash mid-DDL) is safe — each entity's DDL + snapshot update runs in a single transaction. On the next run, the snapshot is unchanged (the transaction rolled back), so the diff is recomputed and retried.

### 14. Lifecycle state evolution

**Add state:** Safe. No DDL. Existing records keep their state.

**Add transition:** Safe. No DDL. Existing states gain new outbound edges.

**Remove state:** Ambiguous. Existing records may be in the removed state. Consumer must provide `evolve.stateMap`:

```ts
evolve: { stateMap: { status: { review: 'draft' } } }
// → UPDATE note SET status = 'draft' WHERE status = 'review'
```

The adapter runs the UPDATE, then updates the CHECK constraint (if present) via Kysely's schema builder. If no `stateMap` is provided, the adapter blocks with: "Lifecycle field 'status' no longer includes state 'review'. Provide evolve.stateMap.status.review to map existing records to a valid state."

**Remove transition:** Safe. No DDL. The validate concern enforces the updated transition map at dispatch time.

**Change initial state:** Safe. Only affects new records.

### 15. Framework metadata column evolution

Framework-managed columns ([01b](01b-record-metadata-ownership-scoping.md)) change when the entity's storage strategy or `owned` flag changes. These follow the same classification rules as consumer columns:

| Change | Columns affected | Classification |
|--------|-----------------|----------------|
| Add `owned: true` | `ownerId` added | Cautious — needs backfill |
| Remove `owned: true` | `ownerId` dropped | Destructive — needs `evolve.drops` |
| Volatile → Persistent | `deletedAt` added | Safe (add nullable) |
| Persistent → Volatile | Entity removed from relational adapter | Destructive — needs `drop()` |
| Singleton → Persistent | `createdAt`, `createdBy` added | Safe (add nullable) |

### 16. What this does NOT cover

**Data migration ETL.** Reconciliation handles schema-level changes. Bulk data transformations are application concerns, modelable as custom actions that run after bootstrap.

**Cross-entity migration.** Renaming an entity, splitting/merging entities — these are graph-level changes requiring coordination across participation, subscription, and binding records. Rare enough to warrant manual orchestration.

**Rollback.** Forward-only. For rollback, revert `define()` changes and add `evolve` for the reverse direction. Database backups are the safety net.

## Testing gate

When 124-04c is implemented:

- **New entity:** `reconcile()` returns no changes; `initialize()` creates table; `_janus_schema` row written
- **No change:** subsequent `reconcile()` with same schema returns empty diff
- **Add nullable column:** auto-applied via `db.schema.alterTable().addColumn()`
- **Add required column without backfill:** blocked with actionable error
- **Add required column with backfill:** auto-applied; existing rows have the backfill value
- **Remove column without acknowledgment:** blocked
- **Remove column with `evolve.drops`:** auto-applied via `db.schema.alterTable().dropColumn()`
- **Rename column:** ambiguous without hint; with `evolve.renames`, applied via `.renameColumn()`; data preserved
- **Nullable → required with backfill:** NULLs backfilled, constraint applied
- **Required → nullable:** auto-applied (safe)
- **Type change without coercion:** blocked (ambiguous)
- **Type change with `evolve.coercions`:** transform applied; column updated
- **Add lifecycle state:** auto-applied; no DDL
- **Remove lifecycle state without stateMap:** blocked; error includes affected row count
- **Remove lifecycle state with stateMap:** affected rows updated; CHECK constraint updated
- **Wiring target change without coercion:** blocked (ambiguous)
- **Add `owned: true` without backfill:** blocked
- **Add `owned: true` with backfill:** ownerId column added, existing rows backfilled
- **Remove entity without `drop()`:** blocked
- **Remove entity with `drop()`:** entity removed from `_janus_schema`; table left in place
- **Storage strategy change (Volatile → Persistent):** table created fresh
- **Storage strategy change (Persistent → Volatile) without `drop()`:** blocked
- **Stale evolve config:** silently ignored
- **Partial failure (crash mid-DDL):** next run retries (transaction rollback preserved snapshot)
- **Database drift (manual ALTER):** `db.introspection.getTables()` detects mismatch; warning surfaced
- **Memory/file/derived/virtual adapter:** `reconcile()` is a no-op
- **Framework entity upgrade:** framework's internal evolve config applies; same pipeline
- **`planReconciliation()` does not execute DDL**
- **`createApp({ reconciliation: 'skip' })` skips reconciliation**
- **SchemaReconciliationError** lists entity, description, and resolution for every blocked change
- **V1 snapshot compatibility:** ported `FieldSnapshot` produces same diff results as v1 `generateMigration()` for equivalent schemas
