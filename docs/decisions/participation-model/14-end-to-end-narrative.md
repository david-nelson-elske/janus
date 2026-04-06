# 124-14: End-to-End Narrative — Community Cleanup Event

**Status:** Living document
**Date:** 2026-04-03
**Purpose:** Trace a realistic use case through the full ADR-124 consumer API, milestone by milestone. This document serves as validation (does the architecture work?), documentation (how does a consumer use this?), and roadmap driver (what's the next piece to build?).

## The Scenario

A Parkdale Community Association board member wants to organize a neighborhood cleanup. They need to:

1. Create the event with details (date, location, description)
2. Create volunteer shifts (morning, afternoon)
3. Publish the event so community members can see it
4. Volunteers sign up for shifts
5. An agent helps draft a follow-up email to volunteers
6. Results get posted to the website

This single scenario exercises: entity definition, lifecycles, ownership, relations, search, subscriptions, binding, agent interaction, and publication — touching every major ADR in the set.

## Entity Definitions

```ts
import { define, participate, subscribe, bind } from '@janus/core';
import {
  Str, Int, Markdown, DateTime, LatLng, Enum,
  Lifecycle, Relation, Persistent,
} from '@janus/vocabulary';

// ── Entities ────────────────────────────────────────────────────

const event = define('event', {
  schema: {
    title: Str({ required: true }),
    description: Markdown(),
    date: DateTime({ required: true }),
    location: Str(),
    coordinates: LatLng(),
    organizer: Relation('volunteer'),
    status: Lifecycle({
      draft: ['published'],
      published: ['completed', 'cancelled'],
      completed: ['archived'],
      cancelled: ['archived'],
    }),
  },
  storage: Persistent(),
  description: 'Community events',
});

const shift = define('shift', {
  schema: {
    event: Relation('event'),
    name: Str({ required: true }),           // "Morning shift", "Afternoon shift"
    start_time: DateTime({ required: true }),
    end_time: DateTime({ required: true }),
    capacity: Int({ required: true }),
    filled: Int(),                           // computed or maintained by subscription
    status: Lifecycle({
      open: ['filled', 'cancelled'],
      filled: ['open', 'cancelled'],         // reopen if someone cancels
      cancelled: [],
    }),
  },
  storage: Persistent(),
  description: 'Volunteer shifts within an event',
});

const registration = define('registration', {
  schema: {
    shift: Relation('shift'),
    volunteer: Relation('volunteer'),
    notes: Str(),                            // "I can bring garbage bags"
    status: Lifecycle({
      confirmed: ['cancelled'],
      cancelled: [],
    }),
  },
  storage: Persistent(),
  description: 'Volunteer registration for a shift',
});

const volunteer = define('volunteer', {
  schema: {
    name: Str({ required: true }),
    email: Str({ required: true }),
    phone: Str(),
  },
  storage: Persistent(),
  description: 'Community volunteers',
});
```

These four entities create a graph:

```
volunteer ←── registration ──→ shift ──→ event
                                          ↑
volunteer (organizer) ────────────────────┘
```

## Milestone Walkthrough

### M1-M3: Define, Compile, CLI — "Set up the event"

**What works:**

```bash
# Create the event
janus create event \
  --title "Spring Cleanup 2026" \
  --description "Annual neighborhood cleanup at Riley Park" \
  --date "2026-05-15T09:00:00Z" \
  --location "Riley Park"

# Create shifts
janus create shift \
  --event <event-id> \
  --name "Morning shift" \
  --start_time "2026-05-15T09:00:00Z" \
  --end_time "2026-05-15T12:00:00Z" \
  --capacity 20

janus create shift \
  --event <event-id> \
  --name "Afternoon shift" \
  --start_time "2026-05-15T13:00:00Z" \
  --end_time "2026-05-15T16:00:00Z" \
  --capacity 15

# Publish the event
janus dispatch event:published --id <event-id>

# Register a volunteer
janus create volunteer --name "Alice Chen" --email "alice@example.com"
janus create registration --shift <shift-id> --volunteer <volunteer-id>

# Check shift registrations
janus read registration
```

**What's missing:** No auth — anyone can create/modify anything. No audit trail. No automatic shift fill count. No HTTP API for a web form. No web UI. No agent assistance.

**Validated:** Entity definitions compile. Lifecycle transitions work (draft → published). Relations connect the graph. CRUD dispatches through the full pipeline. Data persists in SQLite.

---

### M4: Audit — "Who changed what"

**ADRs:** [01b](01b-record-metadata-ownership-scoping.md), [04b](04b-append-storage-and-execution-log.md), [05](05-pipeline-concern-adapters.md)

**What this adds:**

```bash
# After creating the event:
janus read execution_log --where "source=event"
# → Shows: alice created event at 2026-04-15T10:00:00Z

# After publishing:
janus read execution_log --where "source=event AND handler=audit-relational"
# → Shows: alice updated event (status: draft → published) at 2026-04-15T10:05:00Z

# Version conflict protection:
# Two people editing the same event simultaneously → second save fails cleanly
```

**Registration with ownership:**

```ts
const registration = define('registration', {
  schema: { /* ... */ },
  storage: Persistent(),
  owned: true,  // M4: volunteers see only their own registrations
});
```

**The story continues:** The board member creates the event, creates shifts, publishes. Every action is audited. When a volunteer registers, they can only see and cancel their own registrations. The board member can see all registrations because they have an admin role.

---

### M5: Search — "Find what you need"

**ADRs:** [01c](01c-query-field-and-search.md)

**What this adds:**

```bash
# What published events are coming up?
janus read event --where "status=published AND date>2026-04-15T00:00:00Z"

# Which shifts still have capacity?
janus read shift --where "status=open AND filled<capacity"

# Who registered for the morning shift?
janus read registration --where "shift=<morning-shift-id> AND status=confirmed"

# Field discovery (for agents):
janus fields event --json
# → { "title": { "type": "str", "operators": ["eq","ne","contains","startsWith"] },
#     "date": { "type": "datetime", "operators": ["eq","ne","gt","gte","lt","lte"] },
#     "status": { "type": "lifecycle", "operators": ["eq","ne","in"] } }
```

**The story continues:** An agent can now discover what's queryable and ask smart questions. "What events are happening next week?" becomes a programmatic query, not a manual scan.

---

### M6: HTTP — "Open to the community"

**ADRs:** [08](08-http-surface-and-bootstrap.md)

**What this adds:**

```
GET  /api/event                    → list published events
GET  /api/event/:id                → event detail
GET  /api/shift?event=<id>         → shifts for an event
POST /api/registration             → volunteer signs up
POST /api/event/:id/published      → board member publishes
```

**The story continues:** The event is now accessible via HTTP. A simple web form can POST to `/api/registration` to let community members sign up. The CLI is still available for board members, but the community interacts through the web.

**What's still missing:** No real-time updates. No reactive UI. No agent.

---

### M7: Subscriptions — "Things happen automatically"

**ADRs:** [07](07-subscriptions-broker-scheduler.md), [07b](07b-tracked-subscriptions-dead-letter.md)

**What this adds:**

```ts
// When someone registers, update the shift's filled count
subscribe(registration, [
  { on: Created, handler: 'dispatch-adapter',
    config: { entity: 'shift', action: 'update_count' } },
  { on: Acted('cancelled'), handler: 'dispatch-adapter',
    config: { entity: 'shift', action: 'update_count' } },
]);

// When a shift fills up, transition to 'filled'
subscribe(shift, [
  { on: Updated, handler: 'dispatch-adapter',
    config: { entity: 'shift', action: 'check_capacity' } },
]);

// When an event is published, notify the community channel
subscribe(event, [
  { on: Updated, handler: 'webhook-sender',
    config: { url: 'https://hooks.slack.com/...', method: 'POST' },
    tracked: true },
]);

// Day before the event: send reminder to registered volunteers
subscribe(event, [
  { cron: '0 9 * * *', handler: 'dispatch-adapter',
    config: { entity: 'event', action: 'send_reminders' },
    tracked: true },
]);
```

**The story continues:** Registration creates are automatic cascade updates — the shift's fill count stays in sync, and when capacity is reached the shift transitions to 'filled'. The event publication triggers a Slack notification. The day before the event, registered volunteers get a reminder. All tracked subscriptions have execution history in `execution_log`.

---

### M8: Binding — "See it on a page"

**ADRs:** [10](10-presentation-and-binding.md), [12a](12a-connection-protocol-and-sync.md), [12b](12b-client-entity-cache.md)

**What this adds:**

```ts
import { EventDetail } from './components/EventDetail';
import { ShiftList } from './components/ShiftList';
import { RegistrationForm } from './components/RegistrationForm';

bind('event', [
  { component: EventDetail, view: 'detail', config: {
    fields: {
      title: { component: 'heading', agent: 'read-write' },
      description: { component: 'richtext', agent: 'read-write' },
      date: { component: 'date-picker', agent: 'read' },
      location: { component: 'text', agent: 'read-write' },
      status: { component: 'badge', agent: 'read' },
    },
    layout: 'single-column',
  }},
]);

bind('shift', [
  { component: ShiftList, view: 'list', config: {
    columns: ['name', 'start_time', 'end_time', 'capacity', 'filled', 'status'],
    fields: {
      name: { agent: 'read' },
      capacity: { agent: 'read' },
      filled: { agent: 'read' },
      status: { agent: 'read' },
    },
  }},
]);

bind('registration', [
  { component: RegistrationForm, view: 'form', config: {
    fields: {
      shift: { component: 'select', agent: 'read-write' },
      notes: { component: 'textarea', agent: 'read-write' },
    },
  }},
]);
```

**The page:** A board member visits `/event/<id>`. They see the event detail (title, description, date, location, status badge) with the shift list below showing capacity and fill counts. When a volunteer registers in another tab, the fill count updates in real time via SSE.

A community member visits the same page. They see the public event info and a registration form. They pick a shift, add a note, submit. The shift count increments for everyone viewing.

**The binding context:**

```ts
// What the agent sees:
const contexts = bindingRegistry.getActiveContexts();
// → [
//   { entity: 'event', id: '123', view: 'detail',
//     fields: { title: { committed: 'Spring Cleanup', current: 'Spring Cleanup', dirty: false },
//               description: { committed: '...', current: '...', dirty: false },
//               status: { committed: 'published', current: 'published', dirty: false } } },
//   { entity: 'shift', id: null, view: 'list',
//     records: [
//       { id: '456', fields: { name: { committed: 'Morning shift', ... }, filled: { committed: 12, ... } } },
//       { id: '789', fields: { name: { committed: 'Afternoon shift', ... }, filled: { committed: 8, ... } } },
//     ] },
// ]
```

---

### M9: Agent Surface — "The agent helps"

**ADRs:** [09](09-agent-surface-and-session.md)

**What this adds:**

The board member is viewing the event page. They ask the agent: "Can you draft a thank-you email to everyone who registered for the morning shift?"

```
Agent reads:
  session (board-member)    → viewing event:123 in detail view
  binding (event)           → field config, agent interaction levels
  event:123                 → "Spring Cleanup 2026", status: completed

Agent queries:
  registration              → where shift=456 AND status=confirmed
  → 12 confirmed registrations

  volunteer                 → for each registration, resolve volunteer name + email
  → Alice Chen, Bob Smith, Carol Davis, ...

Agent composes:
  "Dear volunteers, thank you for participating in the Spring Cleanup 2026.
   We collected 47 bags of litter and planted 12 trees. Your morning shift
   had 12 volunteers..."

Agent writes to binding context:
  eventCtx.fields.description.current.value = draft email text
  → The email appears in the description field as an unsaved edit
  → Board member reviews, modifies, saves
```

The agent used the same tools for everything: `read` to query entities, binding context to see what's on screen, `write to current` to suggest edits. No special email API, no custom tools. The entity graph IS the tool surface.

---

## What This Proves

Each milestone adds one horizontal layer that makes the entire scenario work better:

| Milestone | Layer | What the cleanup scenario gains |
|-----------|-------|---------------------------------|
| M1-M3 | Define + Dispatch + CLI | Create events, shifts, registrations. Lifecycle transitions. |
| M4 | Audit + Ownership | Who did what. Volunteers see only their registrations. |
| M5 | Search | "Which shifts have space?" as a query. Agent field discovery. |
| M6 | HTTP | Community members can register via web. Public API. |
| M7 | Subscriptions | Auto-fill counts. Slack notifications. Reminders. |
| M8 | Binding | Real-time UI. Board member and volunteer see the same page. |
| M9 | Agent | Draft emails. Summarize registrations. Context-aware assistance. |

No milestone is wasted — each one makes the event scenario concretely better. And the same entities, same participation, same compile work at every stage. The consumer writes `define()` + `participate()` once; the framework delivers more capability as layers are added.

## The Consumer's Total Code

For the complete cleanup event scenario, the consumer writes:

- **4 entity definitions** (~60 lines)
- **4 participate() calls** (~20 lines with audit + policy)
- **4 subscribe() calls** (~15 lines for auto-fill, notifications, reminders)
- **3 bind() calls** (~30 lines for event detail, shift list, registration form)
- **3 Preact components** (~200 lines for the actual UI)
- **1 action handler** (~20 lines for update_count)
- **1 compile() call** (1 line)

~350 lines of consumer code for a complete event management system with audit, search, real-time UI, subscriptions, and agent integration. Everything else — the pipeline, the store, the HTTP surface, the SSE sync, the agent tool discovery — is framework-provided.

## Gaps Identified

Writing this narrative reveals:

1. ~~**`owned: true` on DefineConfig**~~ — **Fixed.** Added `owned?: boolean` to `DefineConfig` and `GraphNodeRecord`. Enforcement deferred to M4 (ADR 01b validate concern + store read scoping).

2. **Custom action declaration for shift.update_count** — the subscription dispatches to `shift:update_count`, which needs to be declared via `participate(shift, { actions: { update_count: { ... } } })`. The action handler reads registration count and updates the shift's `filled` field. **Addressed at M7** when subscriptions are implemented.

3. ~~**Public vs authenticated routes**~~ — **Already supported.** `PolicyConfig.anonymousRead` is in the types. `participate(event, { policy: { rules: [...], anonymousRead: true } })` passes through to the policy-lookup handler config. **Enforcement at M4** when policy-lookup gets a real implementation.

4. **Template rendering for notifications** — M7's reminder subscription needs to render an email from a template with event + volunteer data. This is ADR 10b (Template column type). **Deferred to M7+.**

5. **Computed fields (filled count)** — the `filled` field on shift is best maintained by a subscription handler (action that counts registrations and updates the field). The subscription approach is simpler than Derived and matches the ADR model. **Addressed at M7.**
