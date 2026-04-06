# 124-15: Calendar Domain Entities

**Status:** Draft
**Date:** 2026-04-06
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [02](02-wiring-functions.md) (Wiring Functions), [05](05-pipeline-concern-adapters.md) (Pipeline Concerns), [07c](07c-connectors.md) (Connectors), [08](08-http-surface-and-bootstrap.md) (HTTP Surface)

## Problem

V1's calendar package (`packages/calendar/`) provides calendar domain knowledge as standalone utility functions: RRULE expansion, iCal serialization/parsing, availability checking, and calendar composition via `defineCalendar()`. These are consumed through code-level wiring — callers assemble args, call functions, and act on results.

In the participation model, code-level wiring should be replaced by entity relations. The framework already knows how to traverse relations, enforce permissions, audit, and project to surfaces. Calendar domain concepts that are currently implicit in function arguments should become explicit in the entity graph.

The pure domain math (RRULE expansion, iCal formatting, availability validation) is correct and stays. The question is: what wraps it?

## Guiding principle

**If you want to CRUD it, query it, or have agents discover it — it's an entity.** If it's just math — it's a handler.

## Decision

### Four calendar entities

#### `calendar` — Named temporal lens

A calendar is a named, queryable aggregation of temporal entity records. It can be a source (single entity type with temporal fields) or composite (union of other calendars).

```ts
const calendar = define('calendar', {
  origin: 'framework',
  schema: {
    name: Str({ required: true, unique: true }),
    label: Str(),
    color: Color(),
    kind: Enum(['source', 'composite']),
    // Source calendar fields
    entity_name: Str(),        // which entity type this calendar reads from
    start_field: Str(),        // DateTime field name for event start
    end_field: Str(),          // DateTime field name for event end
    title_field: Str(),        // field or dot-path for display title
    category_field: Str(),     // field or dot-path for category
    filter: Json(),            // browse filter applied to reads
    // Composite calendar fields
    // (composed calendars linked via Relation — see below)
  },
  storage: Persistent(),
});
```

Composite calendars use **relations** to reference their sub-calendars:

```ts
const calendar_member = define('calendar_member', {
  origin: 'framework',
  schema: {
    calendar: Relation('calendar', { required: true }),  // the composite
    member: Relation('calendar', { required: true }),    // a sub-calendar
    order: Int(),
  },
  storage: Persistent(),
});
```

**Why an entity, not config?** Because calendars are discoverable. An agent asks "what calendars exist?" and gets a list. A user creates a new composite calendar through the UI. The PCA website derives its calendar page from a calendar entity read, not from code.

**Actions:**
- `calendar:export` — serialize matching records to iCal format using `serializeICalFeed()`
- Time-windowed reads derived from `start_field`/`end_field` metadata

#### `recurrence_rule` — Pattern that generates occurrences

An RRULE is a thing — you create it, edit it, query "what rules exist for this program?", and agents discover "this series repeats every Wednesday."

```ts
const recurrence_rule = define('recurrence_rule', {
  origin: 'framework',
  schema: {
    rrule: Str({ required: true }),         // RFC 5545 RRULE string
    dtstart: DateTime({ required: true }),   // pattern start
    horizon: DateTime(),                     // max expansion date
    source_entity: Str({ required: true }),  // entity type to generate
    template: Json(),                        // default field values for generated records
    owner: Relation('*'),                    // the entity this rule belongs to (program, series, etc.)
    status: Lifecycle({
      active: ['paused', 'expired'],
      paused: ['active', 'expired'],
    }),
  },
  storage: Persistent(),
});
```

**Actions:**
- `recurrence_rule:expand` — calls `expandRRule()`, returns array of dates
- `recurrence_rule:materialize` — expands and creates actual entity records using `template` + `source_entity`

**Why an entity?** In V1, recurrence is a string field on the parent entity. That makes it invisible — you can't query "show me all active recurrence rules" or "what generates Wednesday skating?" Making it an entity means agents can discover recurrence patterns, and materialization becomes an auditable operation.

#### `availability_set` — Temporal constraints for a resource

Availability is not a JSON blob on a facility — it's a queryable, editable resource constraint.

```ts
const availability_set = define('availability_set', {
  origin: 'framework',
  schema: {
    name: Str({ required: true }),
    windows: Json({ required: true }),       // AvailabilityWindow[]
    blackouts: Json(),                       // string[] (ISO dates)
    lead_time_minutes: Int(),
    horizon_days: Int(),
    resource: Relation('*'),                 // facility, instructor, room, etc.
  },
  storage: Persistent(),
});
```

**Actions:**
- `availability_set:check` — calls `checkAvailability()` with the set's constraints + existing bookings from related entities

**Why an entity?** Because "when is the rink available?" is a question agents need to answer. Because availability changes (holiday blackouts, seasonal schedules) are CRUD operations that get audited. Because conflict detection needs to query availability sets by resource relation.

#### `calendar_subscription` — External iCal feed import

An external iCal feed is a connector. It has a URL, a sync schedule, a last-synced timestamp, and a status lifecycle.

```ts
const calendar_subscription = define('calendar_subscription', {
  origin: 'framework',
  schema: {
    url: Url({ required: true }),
    calendar: Relation('calendar'),
    sync_interval: Cron(),                   // e.g., '0 */6 * * *'
    last_synced: DateTime(),
    status: Lifecycle({
      active: ['paused', 'failed'],
      paused: ['active'],
      failed: ['active'],
    }),
  },
  storage: Persistent(),
});
```

This follows the connector pattern from [07c](07c-connectors.md): the entity holds config, a tracked scheduled subscription triggers sync, and `connector_binding` maps external UIDs to local record IDs. The sync handler calls `parseICalFeed()` on the fetched text and upserts records.

### Calendar participation — temporal field declaration

Consumer entities declare their temporal nature through participation:

```ts
participate(session, {
  calendar: {
    start: 'startsAt',
    end: 'endsAt',
    title: 'title',
    category: 'type',
  },
});
```

This produces a participation record that compile() indexes. The calendar index tells the framework:
- Which entities are calendar-capable
- What their temporal fields are
- Which calendar entities reference them

**Compile-time effects:**
- Time-windowed query params on reads (`?after=...&before=...`)
- iCal feed route derivation (`/api/{entity}/calendar.ics`)
- Calendar metadata in self-description (agents discover "this entity has calendar fields")

### Where the pure functions live

The functions in `@janus/calendar` are domain math. They become handler implementation bodies:

| Function | Called by |
|----------|----------|
| `expandRRule()` | `recurrence_rule:expand` action handler |
| `checkAvailability()` | `availability_set:check` action handler |
| `serializeICalFeed()` | `calendar:export` action handler, iCal feed route |
| `parseICalFeed()` | `calendar_subscription` sync handler |

The package stays as-is — pure, dependency-free functions. The framework integration wraps them in handlers on entities.

## What this does NOT cover

- **UI components** — calendar rendering (month/week/agenda views) is a binding concern, not a domain concern. The `bind()` layer will consume calendar entity data.
- **Recurrence instance management** — materialized occurrences vs virtual occurrences is an implementation choice per-consumer. The framework provides both `expand` (virtual) and `materialize` (persisted) actions.
- **Multi-timezone** — all times are UTC. TZID parameters in iCal are preserved during parsing but not processed. Timezone-aware display is a presentation concern.

## Open questions

1. **Should `Recurrence()` and `Availability()` vocabulary types be kept as field types, or fully replaced by entity relations?** The field types are simpler for basic cases (a single RRULE on an event). The entity approach is more powerful (queryable, relatable, agent-discoverable). Could offer both: field type for simple, entity for complex. Or deprecate field types in favor of always using entities.

2. **How does `calendar:export` handle composite calendars?** It needs to traverse `calendar_member` relations, collect source calendar configs, query each entity type with time-window filters, merge results, and serialize. This is a multi-step handler. Should it be a derived entity instead?

3. **Should `recurrence_rule:materialize` create records through the dispatch pipeline (getting full validation/audit) or through direct store writes (faster, less overhead)?** Pipeline dispatch is correct but potentially slow for bulk materialization. Could batch.

4. **How does the `calendar` participation config interact with existing schema-parse/schema-validate?** Time-windowed query params (`after`, `before`) need to be recognized by schema-parse and translated to store queries. This may need a new concern handler or an extension to the read path.

## Implementation sequence

1. Add `calendar` key to `ParticipateConfig` type
2. Define the four framework entities + participations
3. Add compile-time calendar index (which entities are calendar-capable)
4. Implement `recurrence_rule:expand` and `availability_set:check` actions
5. Add time-windowed read support to the store/pipeline
6. Implement `calendar:export` action + iCal feed route derivation
7. Implement `calendar_subscription` sync via connector pattern
