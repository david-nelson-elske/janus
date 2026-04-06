# 124-04b: Append Column Type & Execution Log

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [04](04-store-adapters-and-crud.md) (Store Adapters), [01b](01b-record-metadata-ownership-scoping.md) (Record Metadata)
**Amends:** [00](00-vocabulary.md) (Vocabulary — new semantic type), [04](04-store-adapters-and-crud.md) (Store Adapters — append column handling), [07b](07b-tracked-subscriptions-dead-letter.md) (consolidates task_run/task_dead_letter)

## Scope

This sub-ADR specifies:
- `Append()` — a semantic column type for file-backed payloads (following the `Asset()` pattern from [08b](08b-assets-and-media.md))
- `execution_log` entity — a Persistent table that replaces 9 separate output entities, with per-row retention and append payload pointers
- File rotation (time-based chunking) for append files
- Per-row retention policies and retention cleanup
- How pipeline concerns and subscription adapters write to the log
- Dead-letter as a status value, not a separate entity
- Payload resolution from append files via pointer

This sub-ADR does NOT cover:
- `emit_records` (stays Persistent — operationally hot, drives subscriptions)
- Pipeline concern adapter implementations ([05](05-pipeline-concern-adapters.md))
- Subscription adapter implementations ([07](07-subscriptions-broker-scheduler.md))
- Tracked subscription semantics (retry, dead-letter lifecycle — [07b](07b-tracked-subscriptions-dead-letter.md))

## Problem

ADR-124 originally specified 9 separate entities for recording what pipeline concerns and subscription adapters did:

- Pipeline output: `audit_records`, `observe_records`, `emit_records`
- Subscription output: `webhook_records`, `stream_records`, `notify_records`, `sync_records`
- Task tracking: `task_run`, `task_dead_letter`

These entities all follow the same pattern: an execution ran, here's what happened. But they use different schemas, different storage strategies (Persistent vs Volatile), and inflate the infrastructure entity count.

Most of this data is historical — nobody queries audit records or webhook delivery logs in real-time. Only `emit_records` is operationally hot (the subscription processor reads it with a cursor). The rest is append-only record-keeping.

Storing heavy payloads (before/after snapshots, response bodies, error traces) in relational columns wastes database space and makes retention management complex. The queryable metadata belongs in the database; the heavy payload belongs in files — the same split that [08b](08b-assets-and-media.md) uses for binary assets.

## Decision

### Append() column type

A new semantic type in the vocabulary, following the same pattern as `Asset()` from [08b](08b-assets-and-media.md):

```ts
function Append(config?: {
  rotation?: 'daily' | 'weekly' | 'monthly';
  directory?: string;  // override default log directory
}): SemanticType
```

Default: `Append()` → monthly rotation.

An `Append()` field stores a pointer to a file-backed payload. The database column holds the pointer (`{file, offset}`). The actual payload lives in an append file on disk (or object storage).

| Aspect | `Asset()` (08b) | `Append()` (this ADR) |
|--------|-----------------|----------------------|
| Points to | Binary file (image, PDF) | JSON payload (audit snapshot, error trace) |
| Backend | filesystem / S3 | append file (JSONL) |
| On write | Binary streamed to backend, metadata stored | JSON serialized, appended to rotation file, pointer stored |
| On read | ID enriched to metadata + URL | Pointer resolved to parsed JSON payload |
| Mutability | Files can be deleted | Append-only — files grow until rotation/retention |

### Write path

```
1. Serialize payload as JSON
2. Append to current rotation file → returns { file, offset }
3. Store pointer as column value in the database row
```

### Read path

```
1. Query database (fast, indexed — all metadata columns)
2. Return rows with pointer column as-is (metadata-only reads)
3. If consumer requests payload → resolve pointer from append file
```

The split follows the rule: **if you query on it, it's a database column. If you're recording what happened, it's in the append file.**

### execution_log entity

Replaces: `audit_records`, `observe_records`, `webhook_records`, `stream_records`, `notify_records`, `sync_records`, `task_run`, `task_dead_letter`.

Does NOT replace: `emit_records` (stays Persistent — subscription processor reads it with a cursor).

```ts
define('execution_log', {
  schema: {
    handler: Str({ required: true, indexed: true }),      // Handler() key that produced this log entry
    source: Str({ required: true, indexed: true }),      // source entity name
    entityId: Str({ indexed: true }),                    // target entity record id
    status: Str({ required: true, indexed: true }),      // completed, running, failed, dead, resolved, abandoned
    timestamp: DateTime({ required: true, indexed: true }),
    duration: Int(),                                     // milliseconds
    attempt: Int(),                                      // for tracked subscriptions (1-based)
    retention: Str({ required: true }),                  // per-row: '7d', '30d', '90d', 'forever'
    payload: Append({ rotation: 'monthly' }),            // pointer to append file
  },
  storage: Persistent(),
  operations: ['read', 'create'],  // append-only — no update, no delete
  origin: 'framework',
});
```

Key differences from the original design:
- **`Persistent()` storage** — the table is a regular database table managed by the relational adapter. No new storage strategy or adapter needed.
- **Per-row `retention`** — each row carries its own retention value. Dead-letter rows get `'forever'`. Observe rows get `'7d'`. Set by the writer, not the entity definition.
- **`Append()` column** for payload — heavy data in files, pointer in the database. Same pattern as `asset.path` in [08b](08b-assets-and-media.md).
- **`operations: ['read', 'create']`** — explicit restriction to append-only. No updates, no deletes.

### What each execution writes

Every execution that previously wrote to a separate output entity now writes a row to `execution_log`. The database columns capture queryable metadata. The `payload` column points to the full record in an append file.

**Pipeline concerns:**

| Execution | status | retention | Payload (in append file) |
|-----------|--------|-----------|--------------------------|
| `audit-relational` | `completed` | `forever` | actor, before, after snapshots |
| `audit-memory` | `completed` | `30d` | actor, before, after snapshots |
| `observe-memory` | `completed` | `7d` | event, count |

**Tracked subscription adapters:**

Tracked subscriptions write multiple rows per execution — see [07b](07b-tracked-subscriptions-dead-letter.md) for the full status progression (running → completed/failed → dead → resolved/abandoned). Each row carries its own retention, with dead rows always set to `'forever'`.

**Untracked subscription adapters:**

Untracked subscriptions do not write to `execution_log`. Fire and forget.

### Dead-letter as status, not entity

The `task_dead_letter` entity is eliminated. Dead-lettered work is an execution_log row with `status: 'dead'` and `retention: 'forever'`. Resolution and abandonment are new rows — not updates to the dead row. See [07b](07b-tracked-subscriptions-dead-letter.md) for full dead-letter semantics.

### File rotation

Append files are named by entity and rotation period:

```
logs/
  execution_log/
    2026-04.jsonl           # current month
    2026-03.jsonl
    2026-02.jsonl
```

Each JSONL line is the payload for one row:

```jsonl
{"actor":"alice","before":{"title":"Old"},"after":{"title":"New"}}
{"trigger":{"kind":"cron","expr":"0 */6 * * *"},"input":{"lastSync":"2026-04-01T00:00:00Z"}}
```

The database row's `payload` column stores `{file: "2026-04.jsonl", offset: 0}` (or equivalent pointer). On read, the framework resolves the pointer to the parsed JSON — same enrichment pattern as `Asset()` URL resolution in respond.

### Retention

A scheduled cleanup job (framework subscription on cron) runs retention:

1. For each `execution_log` row where `timestamp + retention < now`:
   - Delete the database row
2. For each rotation file with no remaining database rows pointing to it:
   - Delete the file

Per-row retention means mixed-retention rows coexist in the same rotation file. The file is only deleted when the last row pointing to it is cleaned up. Rows with `retention: 'forever'` are never cleaned up — their files persist indefinitely.

### Entities replaced

| Old entity | Replaced by |
|-----------|-------------|
| `audit_records` | `execution_log` where handler='audit-relational' |
| `observe_records` | `execution_log` where handler='observe-memory' |
| `webhook_records` | `execution_log` where handler='webhook-sender', tracked=true |
| `stream_records` | `execution_log` where handler='stream-pusher' |
| `notify_records` | `execution_log` where handler='notify-sender', tracked=true |
| `sync_records` | `execution_log` where handler='dispatch-adapter' (for sync actions) |
| `task_run` | `execution_log` rows for tracked subscriptions |
| `task_dead_letter` | `execution_log` where status='dead' |

### Updated infrastructure entity count

| Category | Entity | Storage |
|----------|--------|---------|
| Core | `graph_node` | Derived |
| Core | `participation` | Persistent |
| Core | `subscription` | Persistent |
| Core | `binding` | Persistent |
| Derived | `dispatch_index` | Derived |
| Event log | `emit_records` | Persistent |
| Execution log | `execution_log` | Persistent |
| Discovery | `query_field` | Derived |
| Discovery | `search_index` | Derived |
| Routing | `persist_routing` | Derived |
| Session | `session` | Volatile |
| Connector | `connector_binding` | Persistent |
| Asset | `asset` | Persistent |
| Asset routing | `asset_routing` | Derived |
| Counters | `rate_limit_records` | Volatile |
| Real-time | `connection` | Volatile |
| Real-time | `client_subscription` | Volatile |
| Initiator | `system` | Singleton |
| **Total** | **18** | |

Down from 21+ in the original specification. The `execution` entity was eliminated — Handler() keys on junction records resolve directly from the runtime function registry. Nine separate output entities consolidated into `execution_log`.

## Testing gate

When 124-04b is implemented:

- `Append()` constructor returns a valid semantic type with rotation config
- `execution_log` entity uses `Persistent()` storage with `operations: ['read', 'create']`
- `create()` on execution_log inserts database row AND appends payload to current rotation file
- `read()` on execution_log queries database and returns matching rows (metadata only)
- Payload resolution from append file via pointer returns parsed JSON
- Monthly rotation creates new file at month boundary
- Each row carries its own `retention` value
- Retention cleanup deletes rows past their retention period
- Rotation files with no remaining rows are deleted
- Rows with `retention: 'forever'` are never deleted
- Audit concern writes to execution_log with handler='audit-relational', retention='forever'
- Observe concern writes to execution_log with handler='observe-memory', retention='7d'
- Tracked subscription writes status progression rows (see [07b](07b-tracked-subscriptions-dead-letter.md))
- Dead-letter query: `where: { status: 'dead' }` returns failed tracked subscriptions
- `update()` and `delete()` on execution_log throw `UnsupportedOperationError`
- `emit_records` remains a separate Persistent entity (not affected by this change)
