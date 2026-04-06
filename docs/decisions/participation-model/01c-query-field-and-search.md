# 124-01c: Query Capability & Search

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [01b](01b-record-metadata-ownership-scoping.md) (Record Metadata), [04](04-store-adapters-and-crud.md) (Store Adapters)

## Scope

This sub-ADR specifies:
- The `query_field` Derived entity — agent-discoverable description of how to parameterize reads (and writes)
- Operator sets derived from vocabulary semantic types
- Search dimension model: `searchable` + `indexed` vocabulary hints + framework columns
- How the store adapter builds FTS/vector indexes from schema metadata
- Cross-entity `search_index` as a Derived entity with ownership-aware projection
- How search composes with `where` filtering at the adapter level

This sub-ADR does NOT cover:
- Framework-managed metadata columns (specified in [01b](01b-record-metadata-ownership-scoping.md))
- Specific vector embedding providers (implementation concern)
- Specific FTS backend internals (adapter implementation)

## Problem

ADR-124 gives agents the dispatch_index (what operations exist) and graph_node (what entities look like). But agents don't know **how to parameterize** operations.

A user says "show me upcoming events." The agent needs to know:
1. `event` has a `startDate` field of type `DateTime`
2. `DateTime` supports `$gt`, `$lt`, `$gte`, `$lte` operators
3. `startDate` is sortable
4. Therefore: `read('event', { where: { startDate: { $gt: now } }, sort: [{ field: 'startDate', direction: 'asc' }] })`

A user says "search my notes about budgets." The agent needs to know:
1. `note` has searchable fields (`title` with boost:2, `body`)
2. The `search` param on `ReadParams` does FTS across those fields
3. Therefore: `read('note', { search: 'budgets' })`

None of this is discoverable from the current spec. The `query_field` entity makes it discoverable.

## Decision

### Search is a read parameter

Search is not a separate operation or pipeline concern. It is a parameter on `read()`, already present on `ReadParams.search` in [04](04-store-adapters-and-crud.md). Search composes with `where` filtering — both are applied in a single adapter query.

```ts
// Semantic search + structured filter, combined
read('note', {
  search: 'budget meeting',
  where: { createdAt: { $gt: lastWeek }, ownerId: userId },
  sort: [{ field: 'createdAt', direction: 'desc' }],
  window: { limit: 20 },
});
```

The store adapter handles the composition internally: FTS/vector index query intersected with WHERE clause in a single pass. Ownership scoping from [01b](01b-record-metadata-ownership-scoping.md) is injected before the adapter sees the params.

### Operator sets by semantic type

Each vocabulary semantic type maps to a set of filter operators that the store adapter supports:

| Semantic type | Filter operators | Sortable | Searchable default |
|---|---|---|---|
| `Str` | `$eq`, `$ne`, `$in`, `$contains`, `$startsWith`, `$endsWith` | Yes | If `searchable: true` |
| `Markdown` | — | No | If `searchable: true` |
| `Int`, `Float`, `IntCents`, `IntBps` | `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte`, `$in` | Yes | No |
| `DateTime` | `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte` | Yes | No |
| `Duration` | `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte` | Yes | No |
| `Bool` | `$eq`, `$ne` | No | No |
| `Enum` | `$eq`, `$ne`, `$in` | No | No |
| `Lifecycle` | `$eq`, `$ne`, `$in` | No | No |
| `Email`, `Phone`, `Url`, `Slug` | `$eq`, `$ne`, `$contains` | Yes | If `searchable: true` |
| `Id`, `Token`, `Scope` | `$eq`, `$ne`, `$in` | No | No |
| `Color`, `Icon` | `$eq`, `$ne` | No | No |
| `Relation`, `Reference` | `$eq`, `$ne` (by id) | No | No (but includable) |
| `Mention` | `$eq`, `$ne` (by id) | No | No |
| `Json` | — | No | No |
| `Cron` | `$eq` | No | No |
| `Recurrence`, `Availability`, `LatLng`, `QrCode`, `Asset` | — | No | No |

These operator sets are static — they derive from the type, not from configuration. The adapter implements the operators; the query_field entity exposes them.

### Vocabulary hints for search and indexing

The vocabulary semantic type constructors already support `searchable` and `boost` hints. This sub-ADR adds `indexed`:

| Hint | Purpose | Effect |
|------|---------|--------|
| `searchable: true` | Field is included in FTS index | Adapter indexes field text for full-text search |
| `boost: number` | Field weighting in FTS ranking | Higher boost → more influence on relevance score |
| `indexed: true` | Field is a search filter dimension | Adapter includes field as a filterable column alongside FTS index |

```ts
define('event', {
  schema: {
    name: Str({ searchable: true, boost: 2 }),
    description: Markdown({ searchable: true }),
    startDate: DateTime({ indexed: true }),
    status: Lifecycle({ ... }),  // filterable by default (enum-like)
    venue: Relation('venue'),
  },
  storage: Persistent(),
  owned: true,
});
```

The adapter reads these hints from the schema (via `AdapterMeta`) at `initialize()` time to build FTS indexes with the appropriate fields and dimensions.

### query_field entity

A framework-provided Derived entity compiled from graph_node schemas + vocabulary type metadata:

```ts
// Framework-seeded
define('query_field', {
  schema: { /* derived records */ },
  storage: Derived(),
  origin: 'framework',
});
```

For each entity, `compile()` produces a `query_field` record:

```ts
interface QueryCapabilityRecord {
  readonly entity: string;
  readonly fields: Readonly<Record<string, FieldCapability>>;
  readonly framework: Readonly<Record<string, FieldCapability>>;
  readonly search: SearchCapability | null;
  readonly sort: readonly string[];
  readonly window: { readonly defaultLimit: number; readonly maxLimit: number };
  readonly include: readonly IncludeCapability[];
}

interface FieldCapability {
  readonly type: string;                    // semantic type name
  readonly operators: readonly string[];    // supported filter operators
  readonly sortable: boolean;
  readonly searchable: boolean;
  readonly boost?: number;
  readonly indexed: boolean;
  readonly values?: readonly string[];      // for Enum/Lifecycle fields
}

interface SearchCapability {
  readonly enabled: boolean;
  readonly fields: readonly { field: string; boost: number }[];
}

interface IncludeCapability {
  readonly relation: string;
  readonly target: string;
  readonly fields?: readonly string[];
}
```

### Agent usage

The agent reads `query_field` to understand how to parameterize operations:

```ts
// Agent discovers what it can do with 'event' reads
read('query_field', { where: { entity: 'event' } })

// Returns:
{
  entity: 'event',
  fields: {
    name:      { type: 'Str', operators: ['$eq', '$contains', '$startsWith', ...], sortable: true, searchable: true, boost: 2, indexed: false },
    startDate: { type: 'DateTime', operators: ['$eq', '$gt', '$lt', '$gte', '$lte'], sortable: true, searchable: false, indexed: true },
    status:    { type: 'Lifecycle', operators: ['$eq', '$in'], sortable: false, searchable: false, indexed: false, values: ['draft', 'published', 'cancelled'] },
    venue:     { type: 'Relation', operators: ['$eq'], sortable: false, searchable: false, indexed: false },
  },
  framework: {
    createdAt: { type: 'DateTime', operators: ['$gt', '$lt', '$gte', '$lte'], sortable: true, searchable: false, indexed: true },
    updatedAt: { type: 'DateTime', operators: ['$gt', '$lt', '$gte', '$lte'], sortable: true, searchable: false, indexed: true },
    ownerId:   { type: 'Str', operators: ['$eq'], sortable: false, searchable: false, indexed: true },
  },
  search: { enabled: true, fields: [{ field: 'name', boost: 2 }, { field: 'description', boost: 1 }] },
  sort: ['name', 'startDate', 'createdAt', 'updatedAt'],
  window: { defaultLimit: 20, maxLimit: 100 },
  include: [{ relation: 'venue', target: 'venue' }],
}
```

The agent now knows exactly how to construct: `read('event', { search: 'music', where: { startDate: { $gt: now } }, sort: [{ field: 'startDate', direction: 'asc' }], window: { limit: 10 } })`.

### Query capability for writes

The `query_field` record can also describe write operations:

```ts
// Agent discovers what fields to provide for 'event' create
read('query_field', { where: { entity: 'event' } })

// The same record's fields indicate:
//   name: { required: true, ... }
//   startDate: { required: true, ... }
//   description: { required: false, ... }
//   Framework columns (createdAt, ownerId, etc.) are read-only — agent knows not to provide them
```

The `required` and `readOnly` properties on `FieldCapability` tell the agent what to provide for create/update.

### Cross-entity search index

A framework-provided Derived entity that fans out across multiple entities' search indexes:

```ts
// Framework-seeded
define('search_index', {
  schema: { /* derived records */ },
  storage: Derived(),
  origin: 'framework',
});
```

The `search_index` entity's compute function:
1. Reads all graph_node records that have searchable fields
2. For each entity, queries its store with the search term + ownership scoping
3. Merges results with relevance ranking
4. Returns heterogeneous results with an `entity` field on each record

```ts
read('search_index', { search: 'budget meeting' })
// Returns ReadPage with records like:
// { entity: 'note', id: '123', title: 'Budget Meeting Notes', _score: 0.92 }
// { entity: 'event', id: '456', name: 'Q2 Budget Review', _score: 0.85 }
// { entity: 'document', id: '789', title: 'Annual Budget Draft', _score: 0.78 }
```

**Ownership-aware projection.** The compute function respects per-entity ownership rules:
- For owned entities: filters by `ownerId = identity.id` (from [01b](01b-record-metadata-ownership-scoping.md))
- For public entities: no ownership filter
- Identity flows through the dispatch context into the Derived entity's compute function

**Framework columns as common dimensions.** Every entity in the search index has `createdAt`, `createdBy` (from [01b](01b-record-metadata-ownership-scoping.md)), enabling cross-entity time-range filtering:

```ts
read('search_index', { search: 'budget', where: { createdAt: { $gt: lastWeek } } })
```

### Store adapter responsibilities

The store adapter handles search internally:

1. **Index building** (at `initialize()` time): Reads schema from `AdapterMeta`, identifies `searchable` fields, builds FTS index (FTS5 for SQLite, tsvector for PostgreSQL). Includes `indexed: true` fields and framework columns as filterable dimensions in the index.

2. **Query composition** (at `read()` time): When `ReadParams.search` is present, the adapter performs a single query that intersects FTS results with WHERE clause filters. Not sequential — the FTS index join and WHERE filter happen in one SQL query.

3. **Ranking**: FTS results include a relevance score. The adapter uses `boost` weights from the schema to influence ranking. For SQLite: FTS5 `rank` function. For PostgreSQL: `ts_rank` with weights.

4. **Vector search** (future): The adapter interface supports pluggable embedding backends. When a vector index exists alongside FTS, the adapter can perform hybrid search (BM25 + vector) with reciprocal rank fusion. This is an adapter capability, not a pipeline concern.

## Testing gate

When 124-01c is implemented:

- `compile()` produces `query_field` records for all consumer entities
- `query_field` record for an entity with `Str({ searchable: true })` shows `searchable: true` and correct boost
- `query_field` record for an entity with `DateTime({ indexed: true })` shows the field as a search dimension
- Framework columns appear in `query_field.framework` with correct operators
- `read('query_field', { where: { entity: 'event' } })` returns the capability record
- Operator sets match the semantic type mapping table
- Enum/Lifecycle fields include `values` list
- Relation fields show as `includable`
- `read('search_index', { search: 'test' })` returns results from multiple entities
- search_index respects ownership scoping per source entity
- search_index results include `entity` and `_score` fields
- Time-range filtering works on cross-entity search results via framework columns
