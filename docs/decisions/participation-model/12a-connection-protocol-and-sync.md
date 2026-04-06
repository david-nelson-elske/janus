# 124-12a: Connection Entity & Sync Protocol

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [00](00-vocabulary.md) (Vocabulary), [01](01-core-records-and-define.md) (Core Records), [01b](01b-record-metadata-ownership-scoping.md) (Ownership), [04b](04b-append-storage-and-execution-log.md) (Execution Log), [07](07-subscriptions-broker-scheduler.md) (Subscriptions), [08](08-http-surface-and-bootstrap.md) (HTTP Surface), [09](09-agent-surface-and-session.md) (Agent Surface)

## Scope

This sub-ADR specifies:
- `Channel()` — new backend-resolved semantic type for communication channels
- `connection` Volatile entity — tracks active client channels
- `client_subscription` Volatile entity — what each connection wants to receive
- Connection establishment as entity dispatch (SSE and WebSocket)
- Connection lifecycle handlers: `channel-open`, `channel-close`
- Sync protocol: server→client events, client→server messages
- `stream-pusher` subscription handler — routes entity events to matching connections
- Heartbeat, reconnection, cursor-based gap fill, and stale cleanup
- Framework-seeded routes for SSE and WebSocket endpoints

This sub-ADR does NOT cover:
- Client-side rendering, binding contexts, and agent integration ([12b](12b-client-entity-cache.md))
- Voice/audio streaming (OpenAI Realtime API — framework provisions sessions and tools via [09](09-agent-surface-and-session.md))
- Binding-driven rendering ([10](10-presentation-and-binding.md))

## Context

ADR-124 through sub-ADR 11 specifies the server-side model: entities, pipeline, dispatch, subscriptions, surfaces. But the client is invisible — it makes HTTP requests and gets responses. There is no specification for how clients stay in sync with server-side state changes.

This sub-ADR specifies the connection layer using the same entity-based patterns as the rest of the framework. Connection establishment is entity CRUD. Heartbeat management is a channel lifecycle concern. Stale cleanup is a cron subscription. Event routing is a subscription handler. The connection layer is not a special subsystem — it's entities, handlers, and wiring.

## Decision

### Channel() semantic type

A new backend-resolved column type, following the pattern established by `Handler()`, `Asset()`, `Append()`, and `Template()`:

| Type | In DB | Resolves to |
|------|-------|-------------|
| `Handler()` | String key | Function reference (compile-time) |
| `Asset()` | Path/key | File metadata + URL |
| `Append()` | File pointer | Parsed JSONL entries |
| `Template()` | Path/key | Template source string |
| **`Channel()`** | Protocol identifier | Live stream/socket handle (runtime) |

```ts
Channel(config?: {
  protocols?: readonly string[];  // allowed values, default: ['sse', 'websocket']
})
```

**Storage:** The column stores the protocol identifier (e.g., `'sse'` or `'websocket'`).

**Runtime resolution:** The framework maintains a volatile handle map for entities with `Channel()` fields, keyed by record id. When a handler needs to push data to a channel, it resolves `recordId → handle` from this map.

**Schema signal:** A `Channel()` field on an entity's schema tells the framework to auto-wire channel lifecycle handlers (`channel-open`, `channel-close`) into the entity's participation. This is the same pattern as `Lifecycle()` auto-wiring transition validation.

### connection entity

```ts
define('connection', {
  schema: {
    user_id: Str({ required: true, indexed: true }),
    session_id: Str({ indexed: true }),
    channel: Channel({ protocols: ['sse', 'websocket'] }),
    connected_at: DateTime({ required: true }),
    last_heartbeat: DateTime(),
    cursor: Str(),              // last emit_records cursor — for reconnection gap-fill
  },
  storage: Volatile(),
  origin: 'framework',
});
```

| Field | Purpose |
|-------|---------|
| `user_id` | Identity that owns this connection |
| `session_id` | Associated session (links to [09](09-agent-surface-and-session.md) session entity) |
| `channel` | Protocol identifier + runtime handle resolution |
| `connected_at` | When the connection was established |
| `last_heartbeat` | Updated on each heartbeat cycle. Used by stale cleanup. |
| `cursor` | Last `emit_records` cursor delivered to this connection. Sent by client on reconnection for gap-fill. |

Operations: `read`, `create`, `delete`. No `update` — connections are created and deleted, not modified (heartbeat updates bypass the dispatch pipeline as a direct volatile write for performance).

### client_subscription entity

```ts
define('client_subscription', {
  schema: {
    connection_id: Str({ required: true, indexed: true }),
    entity: Str({ required: true, indexed: true }),
    entity_id: Str({ indexed: true }),
  },
  storage: Volatile(),
  origin: 'framework',
});
```

| Field | Purpose |
|-------|---------|
| `connection_id` | Which connection receives these events |
| `entity` | Which entity type to watch |
| `entity_id` | Specific record (null = all records of this entity type) |

Operations: `read`, `create`, `delete`.

Subscriptions are either type-level (`entity_id` null — receive all events for this entity type) or instance-level (`entity_id` set — receive events only for this record).

### Connection establishment as entity dispatch

SSE and WebSocket connections are established through the normal dispatch pipeline. The HTTP surface exposes two framework-seeded routes:

```
GET /events?subscribe=note,note:123  →  connection:create  (channel='sse')
GET /ws                               →  connection:create  (channel='websocket')
```

These routes are auto-generated when the `connection` entity is compiled with a `Channel()` field. They appear in the route table alongside consumer entity routes.

The dispatch flow for connection establishment:

```
1. HTTP request arrives at /events or /ws
2. http-receive (order=5): parses as connection:create
   - For SSE: extracts subscribe param, sets channel='sse'
   - For WS: sets channel='websocket'
   - For both: extracts auth token
3. http-identity (order=6): resolves identity from token
4. policy-lookup (order=10): checks connection:create permission
5. store-create (order=35): creates Volatile connection record
6. channel-open (order=36): opens SSE stream or upgrades to WebSocket
   - Stores volatile handle in channel map
   - For SSE: parses subscribe param → creates client_subscription records
   - Starts heartbeat interval
   - Enforces per-user connection limit (rejects if over limit)
7. respond-shaper (order=70): skipped (channel-open holds the response)
8. http-respond (order=80): skipped (response is held open)
```

The `channel-open` handler signals to the transport layer that the response should not be finalized — the channel is now long-lived.

### Connection lifecycle handlers

#### channel-open (order=36, non-transactional)

Auto-wired by the `Channel()` schema field. Runs on `connection:create`:

```ts
// Framework-seeded handler
handler('channel-open', async (ctx) => {
  const record = ctx.result.record;
  const protocol = record.channel; // 'sse' or 'websocket'

  // Enforce connection limit
  const existing = await ctx.store.count('connection', { user_id: record.user_id });
  if (existing > MAX_CONNECTIONS_PER_USER) {
    throw new DispatchError('connection_limit', 'Too many active connections');
  }

  // Open channel based on protocol
  const handle = protocol === 'sse'
    ? openSseStream(ctx.httpResponse)
    : upgradeWebSocket(ctx.httpRequest, ctx.httpResponse);

  // Store volatile handle
  channelMap.set(record.id, handle);

  // Start heartbeat interval (managed by the handle)
  handle.startHeartbeat(HEARTBEAT_INTERVAL_MS);

  // For SSE: create initial subscriptions from query params
  if (protocol === 'sse' && ctx.parsed.subscribe) {
    for (const sub of parseSubscribeParam(ctx.parsed.subscribe)) {
      await ctx._dispatch('client_subscription', 'create', {
        connection_id: record.id,
        entity: sub.entity,
        entity_id: sub.entityId,
      });
    }
  }

  // Seed cursor from current emit_records position
  const currentCursor = await ctx.store.read('emit_records', {
    sort: [{ field: 'createdAt', direction: 'desc' }],
    window: { limit: 1 },
  });
  if (currentCursor.records.length > 0) {
    record.cursor = currentCursor.records[0].id;
  }

  // Signal: do not finalize HTTP response
  ctx.channelHeld = true;
}, 'Open SSE/WebSocket channel and store volatile handle');
```

#### channel-close (order=36, non-transactional)

Auto-wired by the `Channel()` schema field. Runs on `connection:delete`:

```ts
handler('channel-close', async (ctx) => {
  const connectionId = ctx.parsed.id;

  // Close the channel
  const handle = channelMap.get(connectionId);
  if (handle) {
    handle.stopHeartbeat();
    handle.close();
    channelMap.delete(connectionId);
  }

  // Cascade: delete all client_subscription records for this connection
  await ctx.store.deleteWhere('client_subscription', { connection_id: connectionId });
}, 'Close channel, remove handle, cascade subscriptions');
```

### Participation and subscription wiring

The framework auto-generates participation and subscriptions for the connection entity:

```ts
// Auto-generated participation (from Channel() schema signal)
participate('connection', {
  policy: { rules: [{ roles: ['user'], operations: ['create', 'read', 'delete'] }] },
  // channel-open and channel-close auto-wired from Channel() field
});

// Auto-generated cron subscription for stale cleanup
subscribe('connection', [
  { cron: '*/2 * * * *', handler: 'stale-connection-reaper', config: { timeoutMs: 90_000 }, failure: 'log' },
]);
```

#### stale-connection-reaper handler

```ts
handler('stale-connection-reaper', async (ctx) => {
  const config = ctx.config as { timeoutMs: number };
  const cutoff = Date.now() - config.timeoutMs;

  const stale = await ctx.store.read('connection', {
    where: { last_heartbeat: { $lt: new Date(cutoff) } },
  });

  for (const conn of stale.records) {
    await ctx._dispatch('connection', 'delete', { id: conn.id });
  }
}, 'Delete connections with stale heartbeats');
```

### Two connection protocols

| Protocol | Direction | Use case | Subscription model |
|----------|-----------|----------|-------------------|
| **SSE** | Server → Client only | Browser UI updates, simple dashboards | Fixed at connection time (URL params) |
| **WebSocket** | Bidirectional | Interactive apps, dynamic subscriptions | Dynamic (subscribe/unsubscribe messages) |

SSE is simpler — works through proxies/CDNs, reconnects automatically via `EventSource`. But subscriptions are fixed at connection time and mutations always go over HTTP.

WebSocket adds bidirectional messaging: the client can subscribe/unsubscribe dynamically, dispatch operations with lower latency, and send navigate messages.

For both protocols, mutations can always fall back to regular HTTP requests. WebSocket dispatch is an optimization, not a requirement.

### Sync protocol messages

#### Server → Client

All messages are JSON with a `type` discriminator:

```ts
type ServerMessage =
  | { type: 'entity:changed'; entity: string; id: string; operation: string;
      record: Record<string, unknown>; cursor: string; timestamp: number }
  | { type: 'entity:deleted'; entity: string; id: string;
      cursor: string; timestamp: number }
  | { type: 'session:updated'; session: Record<string, unknown>;
      timestamp: number }
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'subscribed'; entity: string; id?: string }
  | { type: 'unsubscribed'; entity: string; id?: string }
  ;
```

**`entity:changed`** carries the full record. The `operation` field (`'create'`, `'update'`) lets the client distinguish new records from updates — useful for list UIs (add to list vs. update in place).

**`cursor`** is the `emit_records` cursor for this event. The client stores the latest cursor and sends it on reconnection for gap-fill.

#### Client → Server (WebSocket only)

```ts
type ClientMessage =
  | { type: 'subscribe'; entity: string; id?: string }
  | { type: 'unsubscribe'; entity: string; id?: string }
  | { type: 'dispatch'; entity: string; operation: string;
      input: Record<string, unknown>; requestId: string }
  | { type: 'navigate'; url: string; context?: { entity: string; id?: string; view?: string } }
  ;
```

**`subscribe`/`unsubscribe`** create/delete `client_subscription` records via internal dispatch.

**`dispatch`** sends an operation through the normal dispatch pipeline via the connection's initiator. The `requestId` is echoed back in the response for client-side correlation.

**`navigate`** dispatches a `session:update` for the connection's user. This goes through the normal pipeline — policy, audit, subscriptions all fire. The optional `context` provides structured entity/id/view data alongside the URL.

#### Server → Client (dispatch response, WebSocket only)

```ts
type DispatchResponse =
  | { type: 'dispatch:ok'; requestId: string; data: unknown }
  | { type: 'dispatch:error'; requestId: string; error: { code: string; message: string } }
  ;
```

### stream-pusher subscription handler

The existing `stream-pusher` handler ([07](07-subscriptions-broker-scheduler.md)) routes entity events to matching connections. This sub-ADR specifies its routing logic:

```
1. Subscription processor invokes stream-pusher
2. Read the event: { entity, entityId, operation, record, correlationId }
3. Query client_subscription:
   WHERE entity = event.entity
   AND (entity_id IS NULL OR entity_id = event.entityId)
4. For each matching client_subscription:
   a. Resolve connection record
   b. Originator skip: if connection originated this event (matching correlationId
      on the connection's recent dispatches), skip — the originator already has
      the result from its dispatch response
   c. Visibility check: does connection.user_id have read access to this record?
      (ownership scoping from 01b — same rules as store-read)
   d. Resolve channel handle from volatile map
   e. Format ServerMessage, set cursor on the event
   f. Push to channel
   g. Update connection.cursor to this event's cursor
5. Write delivery to execution_log (handler='stream-pusher')
```

**Originator skip** prevents double-delivery. When a client dispatches a mutation, the dispatch response carries the result. The server-side event from that same mutation should not push back to the originating connection. The `correlationId` from the dispatch context identifies the originator — the `channel-open` handler associates the connection id with recent correlationIds.

**Visibility filtering** applies the same ownership model as `store-read` ([01b](01b-record-metadata-ownership-scoping.md)):
- Owned entity: only push to connections where `connection.user_id = record.ownerId` (or admin/system roles)
- Non-owned entity: push to all matching connections
- The connection's identity must have `read` permission on the entity

### Server-side subscription wiring

For entities to be streamable, they need `stream-pusher` subscriptions. These are auto-generated when `bind()` is called for an entity — if an entity has visual bindings, it should be streamable:

```ts
// Auto-generated when bind('note', [...]) is called
subscribe('note', [
  { on: [Created, Updated, Deleted], handler: 'stream-pusher', config: {}, failure: 'log' },
]);
```

Entities without bindings can still be explicitly subscribed to streaming:

```ts
subscribe('audit_summary', [
  { on: [Created], handler: 'stream-pusher', config: {}, failure: 'log' },
]);
```

### Reconnection and gap fill

When a client reconnects (SSE with `Last-Event-ID`, or WebSocket with a resume message):

1. Connection is established normally (`connection:create` dispatch)
2. The client sends its last cursor (SSE: `Last-Event-ID` header; WS: `resume` message after connect)
3. The server reads `emit_records` from the cursor forward
4. For each event since the cursor, applies visibility + subscription filtering
5. Pushes missed events before resuming live push
6. If the cursor is too old (events have been pruned): sends `{ type: 'error', code: 'cursor_expired' }` — the client must do a full page reload

### Initial cursor seeding

The first page renders via SSR. The connection is established in the browser after hydration. During this gap, server-side changes could be missed. To close the gap:

1. The SSR response includes the current `emit_records` cursor position (embedded in the HTML — see [12b](12b-client-entity-cache.md))
2. The client sends this cursor when establishing its connection
3. The server replays any events between the SSR cursor and the current position
4. No gap, no missed events

### Heartbeat and timeout

- `channel-open` starts a heartbeat interval (configurable, default 30 seconds)
- Each heartbeat: sends `{ type: 'heartbeat', timestamp }` to the client and updates `connection.last_heartbeat` (direct volatile write, not dispatch)
- Client-side: if no message (heartbeat or event) received within the heartbeat timeout (default 60 seconds), reconnect
- `stale-connection-reaper` runs every 2 minutes, deletes connections with `last_heartbeat` older than the stale timeout (default 90 seconds)

### Connection lifecycle

```
establish → active → (heartbeat loop) → disconnect/timeout → cleanup

  establish:
    connection:create dispatch through pipeline
    channel-open: protocol setup, handle stored, heartbeat started, cursor seeded

  active:
    Events pushed via stream-pusher, heartbeats sent
    Client can subscribe/unsubscribe (WebSocket only)
    Client can dispatch (WebSocket or HTTP fallback)

  disconnect (graceful):
    Client closes connection
    connection:delete dispatch → channel-close handler
    Subscriptions cascaded, handle removed

  timeout (ungraceful):
    stale-connection-reaper finds stale last_heartbeat
    Dispatches connection:delete → same cleanup as graceful disconnect
```

### Relation to session

| Entity | Tracks | Cardinality |
|--------|--------|-------------|
| `session` | User focus — what they're viewing | One per user |
| `connection` | Transport channel | Many per user (one per tab) |
| `client_subscription` | What a channel wants to receive | Many per connection |

When the user navigates, the client sends a `navigate` message (WebSocket) or dispatches `session:update` (HTTP). The session change is itself an event that pushes to any connection subscribed to `session`.

### Route declarations

The following routes are framework-seeded on the HTTP surface when the `connection` entity is compiled:

| Method | Path | Maps to | Notes |
|--------|------|---------|-------|
| `GET` | `/events` | `connection:create` | Requires `Accept: text/event-stream`. Subscribe via `?subscribe=entity,entity:id` |
| `GET` | `/ws` | `connection:create` | Requires `Upgrade: websocket` |

These routes are added to the route table derived from the dispatch index ([08](08-http-surface-and-bootstrap.md)), alongside consumer entity CRUD routes. The `basePath` from the HTTP surface config applies (e.g., `/api/events`).

## Testing gate

When 124-12a is implemented:

- `Channel()` semantic type stores protocol identifier, resolves to volatile handle at runtime
- `connection:create` dispatch via `GET /events` creates connection record and opens SSE stream
- `connection:create` dispatch via `GET /ws` creates connection record and upgrades to WebSocket
- `channel-open` enforces per-user connection limit
- `channel-open` seeds cursor from current emit_records position
- SSE subscribe param creates `client_subscription` records
- WebSocket `subscribe` message creates `client_subscription` record via dispatch
- WebSocket `unsubscribe` message deletes `client_subscription` record via dispatch
- Entity update event pushes to matching SSE connections
- Entity update event pushes to matching WebSocket connections
- Originator skip: connection that dispatched a mutation does not receive its own push event
- Visibility filtering: owned entity events only push to owner's connections
- Reconnection with cursor replays missed events from emit_records
- Expired cursor returns error
- Heartbeat keeps connection alive, updates `last_heartbeat`
- `stale-connection-reaper` cron deletes connections with stale heartbeats
- `connection:delete` dispatch closes channel, removes handle, cascades subscriptions
- WebSocket `dispatch` executes operation and returns response with requestId
- WebSocket `navigate` dispatches `session:update` through pipeline
- Entity without `stream-pusher` subscription → client subscribe attempt returns error
- Framework-seeded routes `/events` and `/ws` appear in route table
