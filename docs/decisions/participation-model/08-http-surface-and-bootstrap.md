# 124-08: HTTP Surface and App Bootstrap

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md)–[07](07-subscriptions-broker-scheduler.md) (all foundation + runtime + subscriptions)

## Scope

This sub-ADR specifies:
- `api-surface` and `admin-surface` as initiator graph-nodes
- HTTP transport concern adapters: http-receive, http-identity (JWT and API key), http-respond
- `apiSurface()` and `adminSurface()` convenience constructors
- Route table derivation from the dispatch index
- `createApp()` — bootstrap sequence for packages/next-next
- `App` interface

This sub-ADR does NOT cover:
- Agent surface ([09](09-agent-surface-and-session.md))
- Presentation and binding ([10](10-presentation-and-binding.md))
- Internal dispatch mechanics ([06](06-dispatch-runtime.md) — already specified)

## HTTP transport concerns

Three execution records for the HTTP surface. No `http-router` — routing is compile-time (the initiator join IS the routing).

### http-receive (order=5)

Parses an HTTP request into the dispatch context fields.

```ts
const httpReceive: ExecutionHandler = async (ctx) => {
  const config = ctx.config as HttpReceiveConfig;
  const req = ctx.input as HttpRequest;

  // Extract entity + operation from URL path
  // e.g., /api/notes → entity='note', operation='read'
  // e.g., /api/notes/123 → entity='note', operation='read', id='123'
  // e.g., POST /api/notes → entity='note', operation='create'

  ctx.parsed = {
    ...parseRequestBody(req),
    ...parseQueryParams(req),
    ...(req.params?.id ? { id: req.params.id } : {}),
  };
};

interface HttpReceiveConfig {
  readonly basePath?: string;   // default: '/api'
  readonly cors?: boolean | CorsConfig;
}

interface CorsConfig {
  readonly origin: string | readonly string[];
  readonly methods?: readonly string[];
  readonly headers?: readonly string[];
  readonly credentials?: boolean;
}
```

### http-identity (order=6)

Resolves caller identity from the HTTP request. Two variants:

**JWT variant:**
```ts
const jwtIdentity: ExecutionHandler = async (ctx) => {
  const config = ctx.config as JwtIdentityConfig;
  const req = ctx.input as HttpRequest;
  const token = extractBearerToken(req);

  if (!token) {
    // Set anonymous identity (policy concern will decide if allowed)
    ctx.identity = ANONYMOUS;
    return;
  }

  const payload = verifyJwt(token, config.secret, { issuer: config.issuer });
  ctx.identity = {
    id: payload.sub,
    roles: payload.roles ?? ['user'],
    scopes: payload.scopes,
  };
};

interface JwtIdentityConfig {
  readonly method: 'jwt';
  readonly secret: string;
  readonly issuer?: string;
}
```

**API key variant:**
```ts
const apikeyIdentity: ExecutionHandler = async (ctx) => {
  const config = ctx.config as ApikeyIdentityConfig;
  const req = ctx.input as HttpRequest;
  const key = req.headers[config.header?.toLowerCase() ?? 'x-api-key'];

  if (!key) {
    ctx.identity = ANONYMOUS;
    return;
  }

  // Resolve key → identity (from store or config)
  const identity = await resolveApiKey(key, ctx.store);
  ctx.identity = identity ?? ANONYMOUS;
};

interface ApikeyIdentityConfig {
  readonly method: 'apikey';
  readonly header?: string; // default: 'X-API-Key'
}
```

### http-respond (order=80)

Shapes the dispatch result into an HTTP response.

```ts
const httpRespond: ExecutionHandler = async (ctx) => {
  const config = ctx.config as HttpRespondConfig;

  // The respond-shaper (order=70) has already normalized ctx.result.
  // http-respond wraps it into the HTTP response shape.

  if (ctx.error) {
    ctx.httpResponse = {
      status: errorToHttpStatus(ctx.error),
      body: { ok: false, error: ctx.error },
    };
  } else {
    ctx.httpResponse = {
      status: operationToHttpStatus(ctx.operation, ctx.result),
      body: config.envelope !== false
        ? { ok: true, data: ctx.result?.data ?? ctx.result?.record ?? ctx.result?.page }
        : ctx.result?.data ?? ctx.result?.record ?? ctx.result?.page,
    };
  }

  if (config.cors) {
    ctx.httpResponse.headers = buildCorsHeaders(config.cors);
  }
};

interface HttpRespondConfig {
  readonly cors?: boolean | CorsConfig;
  readonly envelope?: boolean; // default: true (wrap in { ok, data, error })
}
```

### HTTP status mapping

| Operation | Success status |
|-----------|---------------|
| `read` (single) | 200 |
| `read` (page) | 200 |
| `create` | 201 |
| `update` | 200 |
| `delete` | 204 |
| Action (query) | 200 |
| Action (mutation) | 200 |

| Error code | HTTP status |
|-----------|-------------|
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `RATE_LIMITED` | 429 |
| `VALIDATION` | 422 |
| `INVARIANT_VIOLATION` | 422 |
| `UNKNOWN_ENTITY` | 404 |
| `UNKNOWN_OPERATION` | 404 |
| `MAX_DEPTH` | 500 |

## Surface constructors

Convenience functions that produce the `define()` + `participate()` + `InitiatorConfig` for standard surfaces:

### apiSurface()

```ts
function apiSurface(config?: Partial<ApiSurfaceConfig>): {
  definition: DefineResult;
  initiator: InitiatorConfig;
}

interface ApiSurfaceConfig {
  readonly name?: string;           // default: 'api-surface'
  readonly basePath?: string;       // default: '/api'
  readonly cors?: boolean | CorsConfig;
  readonly identity?: JwtIdentityConfig;
  readonly envelope?: boolean;      // default: true
}
```

Produces:
- A `define()` result for the surface entity (Singleton storage, consumer origin)
- An `InitiatorConfig` with participation records for http-receive, http-identity (JWT), http-respond

### adminSurface()

```ts
function adminSurface(config?: Partial<AdminSurfaceConfig>): {
  definition: DefineResult;
  initiator: InitiatorConfig;
}

interface AdminSurfaceConfig {
  readonly name?: string;           // default: 'admin-surface'
  readonly basePath?: string;       // default: '/admin'
  readonly identity?: ApikeyIdentityConfig;
}
```

Same pattern, but uses API key identity instead of JWT.

## Route table derivation

The HTTP layer needs to know which URL paths map to which `(entity, operation)` pairs. This is derived from the dispatch index:

```ts
function deriveRouteTable(
  registry: CompileResult,
  initiator: string,
  basePath: string,
): readonly RouteEntry[]

interface RouteEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly entity: string;
  readonly operation: Operation | string; // string for custom actions
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
```

### Route derivation rules

| Operation | Method | Path |
|-----------|--------|------|
| `read` | GET | `/{basePath}/{plural}` (list) |
| `read` | GET | `/{basePath}/{plural}/:id` (single) |
| `create` | POST | `/{basePath}/{plural}` |
| `update` | PATCH | `/{basePath}/{plural}/:id` |
| `delete` | DELETE | `/{basePath}/{plural}/:id` |
| Lifecycle transition `publish` | POST | `/{basePath}/{plural}/:id/publish` |
| Custom action `pin` | POST | `/{basePath}/{plural}/:id/pin` (scoped) |
| Custom action `export` | POST | `/{basePath}/{plural}/export` (unscoped) |

Entity name pluralization is a simple `name + 's'` convention (configurable per entity if needed).

## createApp()

The bootstrap entry point for a next-next application:

```ts
async function createApp(config: AppConfig): Promise<App>

interface AppConfig {
  readonly declarations: readonly DeclarationRecord[];
  readonly surfaces?: readonly ReturnType<typeof apiSurface | typeof adminSurface>[];
  readonly serve?: { port: number; hostname?: string };
  readonly store?: {
    readonly relational?: StoreAdapter;
    readonly memory?: StoreAdapter;
  };
  readonly version?: string;
}
```

### Bootstrap sequence

```
createApp(config):

  Phase 0: Seed framework
    - seedExecutions() → framework execution records
    - Framework entity definitions (emit_records, execution_log, rate_limit_records, etc.)
    - system initiator

  Phase 1: Compile
    - Merge framework declarations + consumer declarations
    - Merge framework initiators (system) + consumer surface initiators
    - compile(allDeclarations, allInitiators) → CompileResult

  Phase 2: Store initialization
    - createEntityStore({ routing: result.persistRouting, adapters: config.store })
    - adapter.initialize(entities) for each adapter

  Phase 3: Runtime
    - createDispatchRuntime({ registry, store, broker })

  Phase 4: Processors
    - startSubscriptionProcessor({ runtime, broker, store, subscriptions })
    - startScheduler({ runtime, store, subscriptions })

  Phase 5: HTTP (if surfaces configured)
    - For each surface: deriveRouteTable(registry, surface.name, basePath)
    - Wire routes into Hono app
    - If config.serve: listen on port

  Return: App
```

### App interface

```ts
interface App {
  readonly registry: CompileResult;
  readonly store: EntityStore;
  readonly runtime: DispatchRuntime;
  readonly broker: Broker;

  // Convenience dispatch (system initiator, optional identity)
  dispatch(
    entity: string,
    operation: string,
    input: unknown,
    identity?: Identity,
  ): Promise<DispatchResponse>;

  // HTTP
  listen(port: number, hostname?: string): Promise<void>;
  fetch(request: Request): Promise<Response>; // for testing (Hono's fetch interface)

  // Lifecycle
  shutdown(): Promise<void>;
}
```

`app.dispatch()` is a convenience that calls `runtime.dispatch('system', ...)` with a default identity of `SYSTEM`.

## Hono integration

The HTTP layer uses Hono (carried forward from packages/next). A single catch-all route handles all dispatches:

```ts
const honoApp = new Hono();

// For each surface:
for (const route of routeTable) {
  honoApp.on(route.method, route.path, async (c) => {
    const input = {
      ...c.req.param(),
      ...c.req.query(),
      ...(await c.req.json().catch(() => ({}))),
    };
    const entity = route.entity;
    const operation = route.operation;

    const response = await runtime.dispatch(
      surfaceName, entity, operation, input, /* identity resolved by http-identity */
    );

    return c.json(response.httpResponse?.body, response.httpResponse?.status);
  });
}
```

The actual identity resolution happens inside the pipeline (http-identity concern at order=6), not in the Hono handler. The Hono handler passes the raw HTTP request as the dispatch input.

## Testing gate

When 124-08 is implemented, the following should be testable:

- `createApp({ declarations: [...] })` boots successfully with system initiator only
- Adding `apiSurface()` produces HTTP routes for all entities
- `GET /api/notes` → dispatches (api-surface, note, read) → returns JSON page
- `GET /api/notes/123` → dispatches (api-surface, note, read) with id → returns JSON record
- `POST /api/notes` → dispatches (api-surface, note, create) → returns 201 with record
- `PATCH /api/notes/123` → dispatches (api-surface, note, update) → returns 200
- `DELETE /api/notes/123` → dispatches (api-surface, note, delete) → returns 204
- `POST /api/notes/123/publish` → dispatches lifecycle transition → returns 200
- `POST /api/notes/123/pin` → dispatches custom action → returns 200
- JWT identity: valid token → identity extracted; no token → anonymous
- API key identity: valid key → identity resolved; no key → anonymous
- CORS headers present when configured
- `app.fetch(request)` works for test environments (no HTTP server needed)
- `app.shutdown()` stops processors and adapters
