# 124-01b: Record Metadata, Ownership & Data Scoping

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records and define)
**Amends:** [01](01-core-records-and-define.md) (DefineConfig), [04](04-store-adapters-and-crud.md) (CRUD handlers), [05](05-pipeline-concern-adapters.md) (store-read scoping)

## Scope

This sub-ADR specifies:
- Framework-managed metadata columns injected on entity records
- Injection rules: which columns appear based on storage strategy and operation set
- `owned: true` on `DefineConfig` — explicit ownership declaration
- Read scoping: automatic ownership filtering on reads based on identity
- Soft delete via `deletedAt`
- Optimistic concurrency via `version`
- How framework columns interact with search and filtering (foundations for [01c](01c-query-field-and-search.md))

This sub-ADR does NOT cover:
- Query capability entity and agent discoverability ([01c](01c-query-field-and-search.md))
- Cross-entity search index ([01c](01c-query-field-and-search.md))
- Wiring effects / cascades ([01d](01d-wiring-effects-cross-entity-lifecycle.md))

## Problem

ADR-124's participation model specifies how entities wire to pipeline concerns. But it has no model for:

1. **Who owns a record.** Policy checks whether a role can perform an operation, but not which records a user can see. A user with `read` permission on `note` shouldn't see all notes — only their own.
2. **Record provenance.** Who created or last modified a record. Useful for audit, search, and agent context.
3. **Conflict detection.** Concurrent writes to the same record have no detection mechanism.
4. **Safe deletion.** Hard deletes are irreversible. Production systems need soft delete with recovery.

These gaps affect all reads, not just search. The ownership problem is visible in the simplest case: a user browsing their own notes.

## Decision

### Framework-managed metadata columns

Every entity record gets a set of framework-managed columns, injected automatically based on the entity's storage strategy and operation set. These columns are not declared in the consumer's schema — the framework adds them during compilation.

| Column | Type | Injected when | Set by | Purpose |
|--------|------|---------------|--------|---------|
| `createdAt` | DateTime | Entity has `create` operation | `store-create` handler | Creation timestamp |
| `createdBy` | Str | Entity has `create` operation | `store-create` handler (from `identity.id`) | Creator identity |
| `updatedAt` | DateTime | Entity has `update` operation | `store-update` handler | Last modification timestamp |
| `updatedBy` | Str | Entity has `update` operation | `store-update` handler (from `identity.id`) | Last modifier identity |
| `ownerId` | Str | Entity declares `owned: true` | `store-create` handler (from `identity.id`) | Data scoping anchor |
| `version` | Int | Entity has `update` operation | `store-create` (set to 1), `store-update` (increment) | Optimistic concurrency |
| `deletedAt` | DateTime | Entity has `delete` operation | `store-delete` handler (soft delete) | Soft delete marker |

### Injection rules by storage strategy

| Storage | `created*` | `updated*` | `ownerId` | `version` | `deletedAt` |
|---------|-----------|-----------|-----------|-----------|-------------|
| **Persistent** | Yes | Yes | If `owned: true` | Yes | Yes |
| **Volatile** | Yes | Yes | If `owned: true` | Yes | No (ephemeral — hard delete) |
| **Singleton** | No (auto-seeded) | Yes | No (shared record) | Yes | No (never deleted) |
| **Derived** | No (read-only) | No | No | No | No |
| **Virtual** | No (external) | No | No | No | No |

### DefineConfig amendment

`DefineConfig` gains an `owned` flag:

```ts
interface DefineConfig {
  readonly schema: Record<string, SchemaField>;
  readonly storage: StorageStrategy;
  readonly description?: string;
  readonly owned?: boolean;  // NEW — inject ownerId, scope reads
}
```

When `owned: true`:
- The `ownerId` column is injected into the entity's schema during compilation
- `store-create` populates `ownerId` from `identity.id`
- `store-read` automatically scopes results by `ownerId = identity.id` (with exceptions — see below)
- `store-update` and `store-delete` verify `ownerId` matches `identity.id` (unless elevated role)

When `owned` is omitted or `false`:
- No `ownerId` column
- Reads return all records (subject to policy gate)
- The entity's records are shared (reference data, config, public content)

### GraphNodeRecord amendment

The `GraphNodeRecord` gains the ownership flag and a computed metadata column list:

```ts
interface GraphNodeRecord {
  // ... existing fields from 01 ...
  readonly owned: boolean;
  readonly metadataColumns: readonly MetadataColumn[];
}

interface MetadataColumn {
  readonly name: string;
  readonly type: string;  // semantic type name
  readonly injectedFor: string;  // 'create' | 'update' | 'delete' | 'ownership'
}
```

`metadataColumns` is derived during `define()` from the storage strategy, operation set, and `owned` flag. Compile uses this to generate the full schema (consumer fields + metadata columns) for `persist_routing` and store adapter initialization.

### Reserved column names

Framework-managed column names are reserved. If a consumer declares a schema field with any of these names, `define()` throws `ReservedFieldNameError`:

```
Reserved: createdAt, createdBy, updatedAt, updatedBy, ownerId, version, deletedAt
```

### Read scoping

When an owned entity is read, the `store-read` handler automatically adds an ownership filter:

```
store-read(ctx):
  if entity.owned AND identity is not SYSTEM AND identity.roles does not include 'admin':
    inject where.ownerId = identity.id into read params
  proceed with read (including any consumer-specified where + search)
```

The ownership filter composes with consumer-specified `where` and `search` params — it's additive. The store adapter receives the merged params and applies them in a single query.

**Bypass rules:**
- `system` identity: no ownership filter (internal dispatch sees all records)
- `admin` role: no ownership filter (admin reads are unscoped)
- Read with explicit `id`: ownership is still checked — returns null/404 if `ownerId` doesn't match

### Soft delete

When an entity supports `delete` and has `deletedAt`:

1. `store-delete` sets `deletedAt = now()` instead of removing the record
2. All reads automatically filter `WHERE deletedAt IS NULL` (excluded by default)
3. Admin reads with explicit `{ where: { deletedAt: { $exists: true } } }` can see soft-deleted records
4. Hard delete (permanent removal) is a separate concern — not in the default pipeline. Can be modeled as an admin action.

For Volatile entities: hard delete (no `deletedAt`). Ephemeral data doesn't need recovery.

### Optimistic concurrency

When an entity supports `update` and has `version`:

1. `store-create` sets `version = 1`
2. `store-update` reads the current `version`, increments it, and uses a conditional update: `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`
3. If the version doesn't match (concurrent modification), the adapter throws `ConcurrentModificationError`
4. The client can retry with a fresh read

The `version` field is included in read results so clients can track it. The `store-update` handler in [04](04-store-adapters-and-crud.md) is amended to include the version check.

### CRUD handler amendments

**store-create (from [04](04-store-adapters-and-crud.md)):**
```ts
const storeCreate: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  const record = ctx.parsed as NewEntityRecord;

  // Inject metadata
  const now = Date.now();
  const enriched = {
    ...record,
    createdAt: now,
    createdBy: ctx.identity.id,
    ...(entity.owned ? { ownerId: ctx.identity.id } : {}),
    version: 1,
  };

  const result = await ctx.store.create(ctx.entity, enriched);
  ctx.result = { kind: 'record', record: result };
};
```

**store-update:** Adds `updatedAt`, `updatedBy`, increments `version` with conditional check.

**store-delete:** Sets `deletedAt` instead of hard delete (for entities with `deletedAt` column).

**store-read:** Injects `ownerId` filter for owned entities, excludes soft-deleted records.

### Framework columns as search dimensions

The framework-managed columns serve as guaranteed search and filter dimensions across all entities (detailed in [01c](01c-query-field-and-search.md)):

- `createdAt` / `updatedAt` — temporal filtering: "show me recent items"
- `ownerId` — ownership scoping: "show me my items"
- `createdBy` / `updatedBy` — provenance filtering: "show me what Alice modified"
- `deletedAt` — state filtering: "show me deleted items" (admin)

These dimensions are available on every entity that has them, enabling cross-entity queries on a uniform surface.

## Testing gate

When 124-01b is implemented:

- `define('note', { ..., owned: true })` produces `GraphNodeRecord` with `owned: true` and correct `metadataColumns`
- `define('note', { schema: { createdAt: Str() }, ... })` throws `ReservedFieldNameError`
- Persistent + owned entity has all 7 metadata columns
- Singleton entity has only `updatedAt`, `updatedBy`, `version`
- Derived entity has no metadata columns
- `store-create` injects `createdAt`, `createdBy`, `ownerId`, `version` into the stored record
- `store-update` injects `updatedAt`, `updatedBy`, increments `version`
- `store-update` with stale `version` throws `ConcurrentModificationError`
- `store-delete` sets `deletedAt` instead of hard deleting
- `store-read` on owned entity scopes by `ownerId = identity.id`
- `store-read` with `system` identity returns all records (no ownership filter)
- `store-read` with `admin` role returns all records (no ownership filter)
- `store-read` excludes soft-deleted records by default
- Ownership filter composes with consumer `where` and `search` params
