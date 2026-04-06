# 124-01d: Wiring Effects & Cross-Entity Lifecycle

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [03](03-compile-and-dispatch-index.md) (Compile), [04](04-store-adapters-and-crud.md) (CRUD Handlers)

## Scope

This sub-ADR specifies:
- Effect rules on wiring types (Relation, Reference) — what happens to B when A changes
- The `effects` config on `Relation()` and `Reference()`, generalizing `onDelete`
- Reverse wiring index in `CompileResult` — compiled inverse lookup for cascade execution
- Core handler enrichment — restrict checks and cascade propagation inside the CRUD handlers
- Re-entrant dispatch for cascaded operations (via `system` initiator)
- Depth limiting for cascade chains

This sub-ADR does NOT cover:
- Subscription-based async reactions (specified in [07](07-subscriptions-broker-scheduler.md))
- Framework-managed metadata columns (specified in [01b](01b-record-metadata-ownership-scoping.md))
- Query capability (specified in [01c](01c-query-capability-and-search.md))

## Problem

Entities reference other entities via wiring types (Relation, Reference, Mention). When a referenced entity changes — deleted, transitioned, updated — the referencing entity may need to respond: delete itself, nullify the reference, block the operation, or transition its own state.

The vocabulary already supports `onDelete` on Relation, but this is limited to one trigger (delete) and doesn't specify where in the pipeline the cascade executes. ADR-124's pipeline has no mechanism for cross-entity effects.

This is a correctness gap. Without cascades: deleting a user leaves orphaned notes. Archiving a venue leaves its events in an inconsistent state. The framework can't enforce referential integrity.

## Decision

### Effects on wiring types

The `Relation()` and `Reference()` constructors gain an `effects` config that declares what happens to the referencing entity when the referenced entity changes:

```ts
// Simple — delete cascades (backward compatible with onDelete)
author: Relation('user', { onDelete: 'cascade' })

// Equivalent using effects
author: Relation('user', {
  effects: { deleted: 'cascade' },
})

// Full form — multiple triggers
venue: Relation('venue', {
  effects: {
    deleted: 'restrict',
    transitioned: {
      archived: { transition: 'cancelled' },
      suspended: 'nullify',
    },
  },
})
```

### Effect triggers and actions

| Trigger | Fires when | Example |
|---------|-----------|---------|
| `deleted` | Referenced entity is deleted | User deleted → cascade/restrict/nullify notes |
| `transitioned: { [state]: action }` | Referenced entity transitions to named state | Venue archived → cancel events |

| Action | Behavior | Scope |
|--------|----------|-------|
| `'cascade'` | Delete the referencing records | All records where `field = referenced.id` |
| `'restrict'` | Block the operation if referencing records exist | Pre-check before the operation proceeds |
| `'nullify'` | Set the wiring field to null on referencing records | All records where `field = referenced.id` |
| `{ transition: string }` | Transition the referencing records to the named state | All records where `field = referenced.id` |

### Effect config types

```ts
interface WiringEffects {
  readonly deleted?: 'cascade' | 'restrict' | 'nullify';
  readonly transitioned?: Readonly<Record<string, 'nullify' | 'cascade' | { transition: string }>>;
}
```

`Mention()` does not support effects — mentions are weak references with no integrity guarantees.

The existing `onDelete` shorthand maps to `effects.deleted`:
```ts
// These are equivalent:
Relation('user', { onDelete: 'cascade' })
Relation('user', { effects: { deleted: 'cascade' } })
```

When both `onDelete` and `effects.deleted` are provided, `define()` throws `ConflictingEffectConfigError`.

### Reverse wiring index

During `compile()`, the framework scans all graph_nodes' wiring fields, inverts the edges, and collects effect rules into a reverse wiring index:

```ts
interface CompileResult {
  // ... existing fields from 03 ...
  readonly reverseWiring: ReadonlyMap<string, readonly ReverseWiringEntry[]>;
}

interface ReverseWiringEntry {
  readonly sourceEntity: string;    // entity that HAS the relation (e.g., 'note')
  readonly field: string;           // the wiring field name (e.g., 'author')
  readonly wiringKind: 'relation' | 'reference';
  readonly effects: WiringEffects;
}
```

**Example:**

```ts
// Forward wiring (from define):
//   note.author → Relation('user', { effects: { deleted: 'cascade' } })
//   event.venue → Relation('venue', { effects: { deleted: 'restrict', transitioned: { archived: { transition: 'cancelled' } } } })

// Reverse wiring index (computed by compile):
reverseWiring = {
  'user': [
    { sourceEntity: 'note', field: 'author', wiringKind: 'relation', effects: { deleted: 'cascade' } },
  ],
  'venue': [
    { sourceEntity: 'event', field: 'venue', wiringKind: 'relation', effects: { deleted: 'restrict', transitioned: { archived: { transition: 'cancelled' } } } },
  ],
}
```

The core handlers read from `registry.reverseWiring.get(entityName)` to know what effects to apply.

### Compile validation

`compile()` validates effect rules:

| Check | Error |
|-------|-------|
| `{ transition: 'published' }` but target entity has no lifecycle | `InvalidEffectTargetError` |
| `{ transition: 'published' }` but no legal transition to `published` from any state | `UnreachableTransitionEffectError` |
| Circular cascade chains (A cascades to B, B cascades to A) | `CircularCascadeError` |
| `restrict` + `cascade` on the same trigger from different fields | `ConflictingEffectError` |

### Core handler enrichment

Effects are executed inside the core CRUD handlers at order=35. This keeps them transactional and atomic with the originating operation.

**store-delete (enriched):**

```
store-delete(ctx):
  reverseEntries = registry.reverseWiring.get(ctx.entity) ?? []

  // 1. Restrict check — before the delete
  for each entry where entry.effects.deleted === 'restrict':
    count = await ctx.store.count(entry.sourceEntity, { [entry.field]: entityId })
    if count > 0:
      throw RestrictViolationError(ctx.entity, entityId, entry.sourceEntity, count)

  // 2. Perform the delete (soft delete per 01b)
  ctx.before = await ctx.store.read(ctx.entity, { id: entityId })
  await ctx.store.delete(ctx.entity, entityId)

  // 3. Cascade effects — after the delete
  for each entry where entry.effects.deleted === 'cascade':
    records = await ctx.store.read(entry.sourceEntity, { where: { [entry.field]: entityId } })
    for each record in records.records:
      await ctx._dispatch(entry.sourceEntity, 'delete', { id: record.id }, SYSTEM)

  for each entry where entry.effects.deleted === 'nullify':
    await ctx.store.updateWhere(entry.sourceEntity, { [entry.field]: entityId }, { [entry.field]: null })

  ctx.result = { kind: 'void' }
```

**store-update (enriched for transitions):**

```
store-update(ctx):
  // ... existing update logic (fetch before, apply patch, version check) ...

  // After update: check for lifecycle transition effects
  for each lifecycle in entity.lifecycles:
    if ctx.parsed[lifecycle.field] !== ctx.before[lifecycle.field]:
      newState = ctx.parsed[lifecycle.field]
      reverseEntries = registry.reverseWiring.get(ctx.entity) ?? []

      for each entry where entry.effects.transitioned?.[newState] exists:
        action = entry.effects.transitioned[newState]
        records = await ctx.store.read(entry.sourceEntity, { where: { [entry.field]: entityId } })

        if action === 'nullify':
          await ctx.store.updateWhere(entry.sourceEntity, { [entry.field]: entityId }, { [entry.field]: null })

        else if action === 'cascade':
          for each record in records.records:
            await ctx._dispatch(entry.sourceEntity, 'delete', { id: record.id }, SYSTEM)

        else if action.transition:
          for each record in records.records:
            await ctx._dispatch(entry.sourceEntity, 'update', { id: record.id, [lifecycleField]: action.transition }, SYSTEM)
```

### Re-entrant dispatch for cascades

Cascaded operations use `ctx._dispatch()` with `SYSTEM` identity. This means:

- **Full pipeline.** Cascaded deletes/updates go through the target entity's pipeline (validate, core, emit, audit). Cascaded deletes emit `Deleted` events. Cascaded transitions emit `Updated` events. The audit trail captures cascade provenance.
- **System initiator.** No transport wrapping. Policy still runs — but `SYSTEM` identity has unrestricted access. This is intentional: the cascade was authorized by the originating operation's policy check.
- **Depth limiting.** Re-entrant dispatch increments depth (max 5 by default, from [06](06-dispatch-runtime.md)). Cascade chains deeper than the limit throw `MaxDepthExceededError`.
- **Same transaction.** Cascaded dispatches run inside the same transaction as the originating operation. If any cascade fails, the entire transaction rolls back.

### Nullify uses direct store access

Nullify operations use `ctx.store.updateWhere()` directly instead of re-entrant dispatch. This is intentional:
- Nullify is a data fix, not a domain operation — it doesn't need policy/validate/emit
- It avoids depth overhead for potentially large fan-out
- No events are emitted for nullified fields (the referencing entity wasn't meaningfully changed — it lost a broken reference)

### Example: complete cascade scenario

```ts
// Definitions
const user = define('user', { schema: { name: Str() }, storage: Persistent() });
const note = define('note', {
  schema: {
    title: Str(),
    author: Relation('user', { effects: { deleted: 'cascade' } }),
    reviewer: Relation('user', { effects: { deleted: 'nullify' } }),
  },
  storage: Persistent(),
  owned: true,
});
const comment = define('comment', {
  schema: {
    body: Str(),
    note: Relation('note', { effects: { deleted: 'cascade' } }),
  },
  storage: Persistent(),
  owned: true,
});

// When user is deleted:
// 1. Restrict check: no entries with restrict → proceed
// 2. Delete user record (soft delete)
// 3. Cascade: find all notes where author = userId → dispatch delete for each
//    3a. Each note delete cascades: find all comments where note = noteId → dispatch delete for each
// 4. Nullify: update all notes where reviewer = userId → set reviewer = null
//
// Depth: user delete (1) → note delete (2) → comment delete (3) — within limit
// All in one transaction. Audit trail captures the full cascade chain.
```

## Testing gate

When 124-01d is implemented:

- `Relation('user', { effects: { deleted: 'cascade' } })` parses correctly
- `Relation('user', { onDelete: 'cascade' })` maps to `effects.deleted: 'cascade'`
- Both `onDelete` and `effects.deleted` on same field → `ConflictingEffectConfigError`
- `compile()` builds reverse wiring index with correct entries
- `store-delete` with `restrict` effect blocks when referencing records exist
- `store-delete` with `cascade` effect deletes referencing records via re-entrant dispatch
- `store-delete` with `nullify` effect sets wiring field to null on referencing records
- `store-update` with lifecycle transition triggers `transitioned` effects
- Cascaded operations go through full pipeline (emit events, write audit)
- Cascaded operations use `SYSTEM` identity
- Cascade chain respects depth limit (max 5)
- Transaction rollback on cascade failure rolls back the originating operation
- Circular cascade detected at compile time → `CircularCascadeError`
- Nullify uses `updateWhere` directly (no re-entrant dispatch, no events)
- `Mention()` with effects → compilation error
