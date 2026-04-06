# 124-07c: Connectors

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [02](02-wiring-functions.md) (Wiring Functions), [07](07-subscriptions-broker-scheduler.md) (Subscriptions), [07b](07b-tracked-subscriptions-dead-letter.md) (Tracked Subscriptions)
**Open question:** How do connectors, tracked subscriptions, and pipeline concerns relate? Could connector execution be modeled as a concern? See [07b open questions](07b-tracked-subscriptions-dead-letter.md#open-questions) and [open questions](#open-questions) below.

## Scope

This sub-ADR specifies:
- Connector as an entity pattern — not a new framework primitive
- `connector_binding` entity — external ID ↔ local ID mapping
- `connector-distribute` subscription adapter — outbound push to external systems
- Ingest pattern: connector entity + sync action + tracked scheduled subscription
- Distribute pattern: target entity subscription + connector-distribute adapter
- Merge semantics: source-owned vs local-owned
- Checkpoint and resume for large syncs

This sub-ADR does NOT cover:
- Tracked subscription infrastructure (specified in [07b](07b-tracked-subscriptions-dead-letter.md))
- Specific external system integrations (consumer-provided handlers)
- Task run/dead-letter entities (specified in [07b](07b-tracked-subscriptions-dead-letter.md))

## Problem

V1 had a dedicated connector subsystem (`defineConnector()`, `ConnectorRunEntity`, `ConnectorBindingEntity`, checkpoint stores, delivery stores) with direction-specific adapters. This was powerful but heavyweight — a parallel infrastructure alongside the pipeline.

In the participation model, connectors should compose from existing primitives: entities, actions, tracked subscriptions, and store operations. The framework provides the ID mapping infrastructure; the consumer provides the external system handlers.

## Decision

### Connectors are entities, not a framework primitive

There is no `defineConnector()` function. A connector is an entity with:
1. Configuration fields (endpoint, credentials, mapping rules)
2. A `sync` action for ingest (declared via `participate()`)
3. Tracked scheduled subscriptions for triggering (declared via `subscribe()`)
4. The framework-provided `connector_binding` entity for ID mapping

### connector_binding entity

Framework-provided entity for mapping external system IDs to local entity IDs:

```ts
// Framework-seeded
define('connector_binding', {
  schema: {
    connector: Str({ required: true }),      // connector entity name
    entity: Str({ required: true }),          // target entity name
    localId: Str({ required: true }),         // local record id
    externalId: Str({ required: true }),      // external system record id
    externalSource: Str(),                    // external system identifier (for multi-source connectors)
    lastSyncedAt: DateTime(),                 // last successful sync timestamp
    watermark: Str(),                         // staleness tracking token
    direction: Str(),                         // 'ingest' | 'distribute' | 'sync'
    fieldOwnership: Json(),                   // per-field ownership mapping (for bidirectional sync)
  },
  storage: Persistent(),
  origin: 'framework',
});
```

The binding entity is indexed on `(connector, entity, externalId)` for fast lookup during sync. The store adapter creates the appropriate indexes at `initialize()` time.

### Ingest pattern (pull from external)

A connector that pulls data from an external system:

```ts
// 1. Define the connector entity
const mailchimp = define('connector_mailchimp', {
  schema: {
    endpoint: Url({ required: true }),
    apiKey: Token({ required: true }),
    listId: Str({ required: true }),
    mapping: Json({ required: true }),         // { externalField: localField } mapping
    merge: Enum(['source-owned', 'local-owned']),
    checkpoint: Json(),                        // resume position for large syncs
    status: Lifecycle({
      states: ['active', 'paused', 'error'],
      initial: 'active',
      transitions: { active: ['paused', 'error'], paused: ['active'], error: ['active', 'paused'] },
    }),
  },
  storage: Singleton(),
});

// 2. Declare sync action
participate(mailchimp, {
  actions: {
    sync: {
      handler: mailchimpSyncHandler,
      kind: 'effect',
      description: 'Pull contacts from Mailchimp and sync to local contact entity',
    },
  },
});

// 3. Schedule with tracking
subscribe(mailchimp, [
  { cron: '0 */6 * * *',
    handler: 'dispatch-adapter',
    config: { entity: 'connector_mailchimp', action: 'sync' },
    tracked: true,
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 } },
]);
```

### Sync handler pattern

The consumer writes the sync handler. The framework provides binding lookup and dispatch:

```ts
const mailchimpSyncHandler: ExecutionHandler = async (ctx) => {
  const config = await ctx.store.read('connector_mailchimp');
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };

  // Pull from external system (consumer-specific)
  const externalRecords = await fetchMailchimpContacts(config.endpoint, config.apiKey, config.listId, config.checkpoint);

  for (const ext of externalRecords) {
    stats.processed++;

    try {
      // Look up existing binding
      const bindings = await ctx.store.read('connector_binding', {
        where: { connector: 'connector_mailchimp', entity: 'contact', externalId: ext.id },
      });

      const mapped = applyMapping(ext, config.mapping);

      if (bindings.records.length > 0) {
        // Update existing record
        const binding = bindings.records[0];

        if (config.merge === 'source-owned') {
          await ctx._dispatch('contact', 'update', { id: binding.localId, ...mapped });
          stats.updated++;
        } else {
          // local-owned: check watermark for staleness
          if (ext.updatedAt > binding.watermark) {
            // External is newer — merge conflict, skip or flag
            stats.skipped++;
          }
        }

        // Update binding watermark
        await ctx.store.update('connector_binding', binding.id, { lastSyncedAt: Date.now(), watermark: ext.updatedAt });

      } else {
        // Create new record + binding
        const result = await ctx._dispatch('contact', 'create', mapped);
        await ctx._dispatch('connector_binding', 'create', {
          connector: 'connector_mailchimp',
          entity: 'contact',
          localId: result.data.id,
          externalId: ext.id,
          direction: 'ingest',
          lastSyncedAt: Date.now(),
          watermark: ext.updatedAt,
        });
        stats.created++;
      }
    } catch (error) {
      stats.failed++;
      // Continue processing remaining records
    }
  }

  // Update checkpoint for resume
  if (externalRecords.length > 0) {
    const lastRecord = externalRecords[externalRecords.length - 1];
    await ctx.store.update('connector_mailchimp', config.id, { checkpoint: { cursor: lastRecord.id, timestamp: lastRecord.updatedAt } });
  }

  // Stats are captured in execution_log via tracked subscription
  ctx.result = { kind: 'output', data: stats };
};
```

### Distribute pattern (push to external)

A subscription on the target entity triggers outbound push:

```ts
// Framework-provided subscription adapter
// Registered via handler() like other adapters
handler('connector-distribute', connectorDistributeHandler, 'Push entity changes to external system via connector');

// Consumer wires it
subscribe('contact', [
  { on: Updated,
    handler: 'connector-distribute',
    config: {
      connector: 'connector_mailchimp',
      mapping: { name: 'FNAME', email: 'EMAIL' },  // local → external field mapping
      endpoint: 'https://api.mailchimp.com/...',
    },
    tracked: true,
    retry: { max: 3, backoff: 'exponential', initialDelay: 2000 } },
]);
```

The `connector-distribute` adapter:
1. Reads the event (entity changed)
2. Looks up the binding (local ID → external ID)
3. Maps local fields to external fields
4. Pushes to the external system
5. Updates the binding watermark

### Merge semantics

| Strategy | Meaning | Conflict resolution |
|----------|---------|-------------------|
| `source-owned` | External system is authoritative | External data overwrites local on ingest |
| `local-owned` | Local system is authoritative | Watermark-based staleness check; skip stale external updates |

For bidirectional sync, the `fieldOwnership` field on `connector_binding` tracks which system owns each field. This enables per-field merge: some fields are source-owned, others are local-owned.

### Checkpoint and resume

Large syncs (thousands of records) need checkpoint/resume:

1. The connector entity's `checkpoint` field stores the resume position (cursor, timestamp, page number — format is connector-specific)
2. The sync handler reads the checkpoint and passes it to the external system API (e.g., `?since=timestamp` or `?cursor=abc`)
3. After processing a batch, the handler updates the checkpoint
4. If the sync fails mid-way, the next run resumes from the checkpoint
5. A full re-sync can be triggered by clearing the checkpoint

### Updated infrastructure entity count

| Entity | Storage | Purpose | New? |
|--------|---------|---------|------|
| `connector_binding` | Persistent | External ID ↔ local ID mapping | **Yes** |
| `connector-distribute` | — (execution record) | Subscription adapter for outbound push | **Yes** (execution, not entity) |

Total infrastructure entities: ~18 fixed. See [index Decision 8](index.md#8-infrastructure-entity-count-is-fixed) for the complete count.

## Open questions

### Is a connector an initiator?

When a connector ingests data, it dispatches create/update operations on local entities via `_dispatch` with `SYSTEM` identity. An alternative model: the connector could be an initiator (like `api-surface`), with its own transport executions (connector-receive, connector-identity, connector-respond). This would give connectors their own pipeline shape and make connector dispatches visible as a distinct initiator in the dispatch_index.

Arguments for initiator model:
- Connector dispatches are distinguishable from system dispatches in audit trail
- The connector could have its own identity model (mapping external user to local user)
- Pipeline stages (policy, rate-limit) could be configured differently for connector dispatches

Arguments for current model (system dispatch):
- Simpler — no new initiator type
- Connector actions are already entity actions dispatched via subscribe
- Identity mapping can be handled in the sync handler

### How does connector execution relate to concerns?

If a connector's sync action is a tracked subscription that dispatches to itself, and the dispatch goes through the standard pipeline, then the sync handler is just an action handler at order=35. It's already a concern in the pipeline sense. The tracking comes from the subscription layer (07b), not from the pipeline.

But one could argue that ingest/distribute is a cross-cutting concern — like audit or emit — that should be wired via participation rather than subscription. This would mean: `participate('contact', { connector: { mailchimp: { ... } } })` instead of defining a separate connector entity.

This question is deferred. The current entity-based model is more explicit and more discoverable (the connector is browseable). If patterns emerge during implementation that suggest a concern model is cleaner, this can be revisited.

## Testing gate

When 124-07c is implemented:

- Connector entity (Singleton) can be defined with config, mapping, status lifecycle
- Sync action can be declared via `participate()`
- Tracked scheduled subscription triggers sync action on cron
- Sync handler can read/write `connector_binding` records
- Sync handler can dispatch create/update on target entities via `_dispatch`
- Binding lookup by `(connector, entity, externalId)` returns existing binding
- New records create new binding alongside the entity record
- Checkpoint is updated after successful batch processing
- Failed sync mid-way can resume from checkpoint on next run
- `connector-distribute` adapter pushes changes to external system on entity update
- Distribute adapter updates binding watermark after push
- Run tracking via `execution_log` shows sync history (handler='dispatch-adapter', source='connector_mailchimp')
- Failed syncs appear in `execution_log` with `status='dead'` after retry exhaustion
- Source-owned merge overwrites local data
- Local-owned merge skips stale external updates
