# 124-12d: Binding Loaders

**Status:** Draft
**Date:** 2026-04-21
**Depends on:** [10](10-presentation-and-binding.md) (Binding Model), [12c](12c-consumer-rendering-hooks.md) (Consumer Rendering Hooks), [08](08-http-surface-and-bootstrap.md) (HTTP Surface)
**Package:** `@janus/core`, `@janus/http`

## Scope

This sub-ADR specifies a single hook that lets a binding compose its own page data through an async loader:

- **Binding loader** — a function declared on a binding's config that runs before the component renders; its return value reaches the component as the `data` prop. The framework skips its default single-entity read when a loader is present.

This sub-ADR does NOT cover:

- **View-owned layout** (suppressing the framework shell entirely so a view can render its own three-pane/dashboard chrome) — separate ADR.
- **Declarative route policy on bindings** (requiring a tier/role before the handler runs) — separate ADR.
- **Client-side re-fetching of loader data.** The loader runs on the server per request; streaming, partial re-runs, or client-triggered reloads are out of scope.
- **Hydration of loader payloads.** `__JANUS__` still serializes binding contexts; loader output is not placed in the hydration blob. See Open Questions.

## Context

[ADR-12c](12c-consumer-rendering-hooks.md) closed the consumer-facing rendering blockers (theme, shell, list query params) for apps with simple entity-shaped pages. It does not help apps whose pages are shaped by a graph of entities rather than a single record.

### The shape of real consumer pages

`perspicuity`'s decision detail page (`src/pages.ts:1334-1443`, `loadDocumentData`) loads **eight** entities for one route:

```
decision → framework → framework_transition → framework (resolving target names)
        ↘ journey   → decision (for journey phase breadcrumb)
        ↘ step
        ↘ section  → entry → item
```

The composed payload fed to the detail component is:

```ts
{ decision, sections, steps, frameworkName, framework, transitions,
  completedStepIds, journeyTitle, journeyPhases }
```

No single-entity read can produce this. The framework's detail-view dispatch is `runtime.dispatch('system', entity, 'read', { id }, identity)` — one entity, no composition. Perspicuity ships `enablePages: false` and hand-writes ~1,800 lines of SSR handlers to work around this.

This is not a perspicuity-specific oddity. `balcony-solar`, `community-association`, and `directory-listings` all have pages that compose across entities (a listing + its tag assignments + its affiliate links; a project + its members + its milestones). All of them have either declined to use bindings or declared them and then bypassed them — for the same reason.

### What the framework currently bakes in

`packages/http/page-handler.ts:64` (list):

```ts
const response = await runtime.dispatch('system', route.entity, 'read', readInput, identity);
```

`packages/http/page-handler.ts:112-118` (detail):

```ts
const response = await runtime.dispatch(
  'system', route.entity, 'read', { id: route.id }, identity,
);
```

A single read of the bound entity is the entire data-fetching contract. The component receives the record (detail) or the page (list). There is no place to compose. There is no pre-render hook.

### Why this blocks real apps

A binding that can only show one entity at a time means every page that needs context around that entity has to exit the binding system. Exiting means:

- Rewriting SSR from scratch (the ~1,800 lines in `perspicuity/src/pages.ts`).
- Hand-wiring identity + policy enforcement (since the framework's identity resolution only runs inside the page handler).
- Losing the benefit of ADR-12c's theme + shell, because once a route is custom, the framework's rendering pipeline isn't involved.

These aren't separate problems. They're the same missing layer: a place for a binding to fetch composed data using the request's resolved identity, through the same dispatch pipeline that already enforces policy.

## Decision

A single optional field on `BindingConfig`. Opt-in per binding view. Default (no loader) preserves today's behavior bit-for-bit.

### Loader contract

```ts
export interface LoaderContext {
  /** Route params extracted from the URL. Detail: { id }. List: {}. */
  readonly params: { readonly id?: string };
  /** Identity resolved from the session cookie, or ANONYMOUS. */
  readonly identity: Identity;
  /** The parsed request URL (use for custom query params). */
  readonly url: URL;
  /** The raw Fetch Request (use for headers / body). */
  readonly request: Request;
  /** Shortcut for a `read` dispatch. Threads `identity` automatically;
   *  throws on dispatch failure. Returns the response `data` directly. */
  read(entity: string, input?: unknown): Promise<unknown>;
  /** General-purpose dispatch helper. Returns the full DispatchResponse. */
  dispatch(entity: string, operation: string, input?: unknown): Promise<DispatchResponse>;
}

export type Loader<TData = unknown> = (ctx: LoaderContext) => Promise<TData>;

export interface BindingConfig {
  // ...existing fields (fields, columns, layout, title)
  readonly loader?: Loader;
}
```

Usage — simple composition:

```ts
bind(decision, [
  {
    component: DecisionDocument,
    view: 'detail',
    config: {
      loader: async (ctx) => {
        const decision = await ctx.read('decision', { id: ctx.params.id });
        const steps = await ctx.read('step', {
          where: { framework: (decision as { framework: string }).framework },
        });
        return { decision, steps };
      },
    },
  },
]);
```

Usage — list projection:

```ts
bind(decision, [
  {
    component: Dashboard,
    view: 'list',
    config: {
      loader: async (ctx) => {
        const jPage = await ctx.read('journey', { where: { owner: ctx.identity.id } });
        const journeys = (jPage as { records: unknown[] }).records;
        return { journeys };
      },
    },
  },
]);
```

### Behavior

- When `config.loader` is present on a binding view, the page handler awaits the loader and passes its return value to the component as `props.data`. The default single-entity read is skipped.
- When absent, behavior is pre-12d: list views run the filtered read; detail views run the read-by-id; the component receives `contexts`/`context`/`fields`/`config` as before.
- Loader errors (thrown) render the framework error page with a 500 status, mirroring dispatch-error handling today.
- `contexts` passed to `renderPage` is `[]` when a loader is used. `__JANUS__` hydration serializes an empty context array. Loader-driven views that need client-side hydration must ship their own serialized payload in the component markup (pragmatic reality today; see Open Questions).

### Authorization

`ctx.read` and `ctx.dispatch` are thin wrappers around `runtime.dispatch('system', entity, op, input, ctx.identity)`. Every call flows through the compiled pipeline — the same `policy-lookup` concern (order 10) that guards API requests enforces loader-initiated reads. **A loader cannot bypass authorization.** Anonymous requests hitting a policy-restricted entity see the policy-concern error surface as a 500 error page (see test: `binding-loaders.test.ts > authorization`).

The identity on `ctx` is the same one resolved from the session cookie in `page-handler.ts:46-50`. There is no mechanism for the loader to spoof identity — the runtime dispatch signature requires an `Identity`, and the loader context only exposes helpers that pre-bind it.

## Data flow summary

```
Request: GET /decisions/abc123
  ↓
page-handler resolves identity from session cookie → identity
  ↓
route = { entity: 'decision', view: 'detail', id: 'abc123' }
  ↓
binding = registry.bindingIndex.byEntityAndView('decision', 'detail')
  ↓
┌───────────────────────────────────────────────────────────────┐
│ IF binding.config.loader:                                     │
│   ctx = LoaderContext { params:{id:'abc123'}, identity, url,  │
│                         request, read, dispatch }             │
│   data = await loader(ctx)                                    │
│     loader internally:                                         │
│       await ctx.read('decision', {id:'abc123'})               │
│         → runtime.dispatch('system','decision','read',…,id)   │
│             → policy-lookup + validate + read concerns         │
│       await ctx.read('step', {where:…})                       │
│         → same path, identity threaded                        │
│   renderPage({ contexts: [], binding:{…,component: wrapped}, …})│
│   wrapped component receives props.data                       │
│                                                               │
│ ELSE (default path — unchanged from pre-12d):                │
│   runtime.dispatch('system', entity, 'read', {id}, identity) │
│   renderPage({ contexts: [ctx], binding, … })                 │
│   component receives props.context / props.fields / props.config│
└───────────────────────────────────────────────────────────────┘
  ↓
ssr-renderer wraps in theme/shell (ADR-12c) and returns HTML
```

No new pipeline stages. No new dispatch semantics. The loader is a consumer-provided function that orchestrates existing dispatches.

## Migration

**Backward compatibility.** `loader` is optional on `BindingConfig`. Every existing binding continues to render byte-identical HTML. No consumer app needs to change anything when this ships.

**Adoption path for perspicuity** (the driving consumer):

1. Add a loader to the `decision` detail binding that reproduces `loadDocumentData`.
2. Update `DecisionDocument` to consume `props.data` instead of its current custom-handler arguments.
3. Delete `renderDocumentPage` from `pages.ts` and its `/decisions/:id` custom route.
4. Repeat for the dashboard binding.
5. Flip `enablePages: true`.

Target LOC delta for perspicuity once both pages migrate: ~-1,500 LOC (custom handlers) + ~150 LOC (loader declarations).

**Adoption path for balcony-solar / community-association**: same shape — add loaders, delete the custom admin-routes factory one page at a time.

**Path for new apps.** Declare the binding with a loader from day one; never hand-write an SSR handler for an entity-shaped page. The framework owns routing, identity, authorization, theme, and shell; the loader owns data composition; the component owns markup.

## Implementation notes

Files changed:

1. `packages/core/types.ts` — add `LoaderContext`, `Loader<TData>` type alias, optional `loader` on `BindingConfig`.
2. `packages/core/index.ts` — export `LoaderContext`, `Loader`.
3. `packages/core/bind.ts` — carry `input.config.loader` through the frozen config.
4. `packages/http/page-handler.ts` — loader branch in both list and detail view paths; `runLoader` helper builds the `LoaderContext` with identity-threaded `read`/`dispatch`.
5. `packages/http/__tests__/binding-loaders.test.ts` (new) — 8 tests covering: loader output flows to `data` prop, default behavior preserved without loader, params threading, url access, error surfacing, policy enforcement through `ctx.read`.
6. `examples/dev-app/components/adr-detail-composed.ts` (new) — reference component that consumes loader-composed `{ adr, questions }`.
7. `examples/dev-app/bindings.ts` — ADR detail binding switched to a loader that composes with its linked questions.

Pre-existing `examples/dev-app/components/adr-detail.ts` is retained as the reference for the context-based pattern (no loader).

LOC: +90 in `@janus/core` + `@janus/http`, +200 tests, +60 dev-app. Strictly additive; no deletions.

## Open Questions

1. **Hydration of loader payloads.** The loader returns an arbitrary `unknown`. We do not currently place it in `window.__JANUS__` — `serializeInitData` only takes `BindingContext[]`, and the loader output has no equivalent record structure. This is fine when the loader-driven view is server-rendered only (no client rehydration), which covers perspicuity's near-term needs. A future ADR could extend `__JANUS__` with a `loaderData` blob if a consumer hits a hydration case. Deferred.

2. **Loader return-type parameterization.** `BindingConfig` does not carry a type parameter for the loader's return type — consumers must cast or use `satisfies` to get strong typing. Adding a generic `BindingConfig<TData>` was considered but rejected for v1 because it cascades through `BindingInput`, `BindingRecord`, and every internal signature that touches them. Revisit if real consumers hit painful casts.

3. **Per-loader timeout / abort signal.** A long-running loader currently blocks the request. Hono will eventually close the connection, but there's no explicit abort path. Deferred; revisit if loaders become a latency-issue vector.

4. **Observability.** Loader execution isn't emitted as an observable event today. `ctx.dispatch` does (through the normal dispatch emit path). If loaders become the dominant data-fetch path, we likely want a `loader:start` / `loader:end` emit for tracing. Deferred — ship the hook first, measure usage, add observability when there's evidence it's needed.

## Resolved Questions

### Should the loader live at the binding level (per entity) or the view level (per list/detail)?

Per-view. Mirrors the existing per-view placement of `columns`/`fields`/`layout`. A binding's list loader and detail loader compose different data; forcing one loader for both views would be awkward.

### Should `contexts` include a synthesized record derived from the loader payload?

No. The loader payload is arbitrary shape — we cannot construct a valid `BindingContext` from it. Passing `contexts: []` when a loader is present is simpler and honest; the component that used a loader opted out of the `context`-based field pattern intentionally.

### Should the loader receive the `DispatchRuntime` directly instead of wrapped `read`/`dispatch` helpers?

No. Wrapping forces identity threading — the loader can't accidentally call `runtime.dispatch(...)` with the wrong identity and bypass policy. The ergonomic cost (two extra helper functions vs. one raw runtime) is small; the authorization guarantee is load-bearing.

### Does this supersede or modify ADR-10?

No. ADR-10 defines bindings as entity-to-component mapping. This ADR layers data composition on top without changing that mapping. [ADR-10](10-presentation-and-binding.md) remains Draft; this ADR is one more step toward closing it.

### Should `ctx.read`'s error path return `null` or throw?

Throw. Callers writing `const x = await ctx.read('foo', { id })` want the error to propagate — returning `null` would silently hide dispatch failures and require every loader to write boilerplate null-checking. Consumers who want the raw response use `ctx.dispatch(...)` which returns `DispatchResponse` and exposes `ok/error`.

## Implications

- Unblocks `perspicuity` to migrate its two binding-shaped pages (dashboard, decision detail) to the framework — the single largest blocker in the Phase-0 gap analysis (see `perspicuity/docs/janus-binding-gaps.md`).
- Sets up the next two ADRs in the rollout: view-owned layout (BVL) and declarative route policy (BRP). Neither is coherent without loaders — a loader provides the data a full-page layout needs; a policy check is only useful when the framework is actually running the page.
- Establishes the precedent that bindings can grow async hooks. Future extensions (e.g., per-binding `onMount`, `onEvent` handlers) follow the same pattern.
- Does not create any new entity types, storage adapters, or pipeline stages. The loader is pure orchestration over the existing dispatch API.
