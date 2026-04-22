# 124-12f: Binding Route Policy

**Status:** Draft
**Date:** 2026-04-21
**Depends on:** [10](10-presentation-and-binding.md) (Binding Model), [12c](12c-consumer-rendering-hooks.md) (Consumer Rendering Hooks), [12d](12d-binding-loaders.md) (Binding Loaders), [12e](12e-view-owned-layout.md) (View-Owned Layout)
**Package:** `@janus/core`, `@janus/http`

## Scope

This sub-ADR adds a single optional hook on `BindingConfig` that lets a binding declare its authorization contract. The framework enforces the check before any data fetch or rendering runs.

- **`config.require`** — an async predicate returning `true` (allow), `false` (403 forbidden page), or `{ redirect }` (302 to the given URL). Receives the same `LoaderContext` a loader does, so the check can consult the dispatch pipeline to resolve tier/ownership/membership information.

This sub-ADR does NOT cover:

- **App-level middleware.** Consumers keep using framework middleware (Hono routes, etc.) for cross-cutting concerns like rate limiting, logging, or global auth. `require` is specifically for per-binding access control that travels with the view.
- **Ownership field enforcement on reads / writes.** That remains the policy concern's job (ADR-05); `require` runs *before* dispatch and is about "can this user see this page at all."
- **Entity-level policy.** `participate(entity, { policy: ... })` still governs API-level operations. `require` is orthogonal — same identity, different gate.
- **CSRF / CORS / rate limiting.** Transport-level concerns live elsewhere.

## Context

[ADR-12d](12d-binding-loaders.md) gave bindings async data composition. [ADR-12e](12e-view-owned-layout.md) gave bindings full control over their layout. What's missing: the authorization gate that today lives as hand-wired middleware in every consumer app.

### What Perspicuity does today

`perspicuity/src/serve.ts:395-411` (from the gap analysis):

```ts
const requireActiveMember = async (c, next) => {
  const identity = await resolvePageIdentity(c.req.raw);
  if (!identity) return c.redirect('/api/auth/login');
  if (identity.tier === 'none') return c.redirect('/activate');
  return next();
};
// ...
server.use('/decisions/*', requireActiveMember);
server.use('/journeys', requireActiveMember);
server.use('/journeys/*', requireActiveMember);
```

Every consumer app that wants tier-gated pages writes a variant of this. `balcony-solar` has a parallel middleware on `/admin/*`; `community-association` hand-wires auth on every route. The gate is real and necessary, but its declaration is separated from the view it protects — which means:

- Forgetting the middleware silently opens a page to anonymous users.
- Route-based middleware can't easily see which binding is being rendered.
- Adding a new binding means editing both `bindings.ts` and `serve.ts`; the framework never sees the coupling.

### Why this belongs on the binding

The binding is the declarative seam where a view says "here's what I am and how to render me." Authorization is part of what a view *is* — a dashboard for active members is meaningfully different from a public landing page bound to the same entity. Putting the gate on the binding:

- **Colocates rule with view.** Changing the dashboard's auth requirements is one edit, next to the loader that fetches its data.
- **Runs with the request's identity unchanged.** The same `ctx` a loader uses is the same `ctx` a gate uses. No separate identity resolution, no middleware-vs-handler context mismatch.
- **Makes the framework authoritative.** `@janus/http`'s page handler, not consumer route registration order, enforces the check.

## Decision

A new optional field on `BindingConfig`:

```ts
export type BindingRequireResult =
  | true                           // allow, proceed to loader / default read
  | false                          // deny, render 403 forbidden page
  | { readonly redirect: string }; // deny, 302 to the given URL

export type BindingRequire = (
  ctx: LoaderContext,
) => BindingRequireResult | Promise<BindingRequireResult>;

export interface BindingConfig {
  // ...existing fields (fields, columns, layout, title, loader, renderMode)
  readonly require?: BindingRequire;
}
```

### Behavior

| `require` returns | Framework response |
|---|---|
| `true` | Proceed. Loader runs, or default read runs, or component renders. |
| `false` | `HTTP 403` with the framework's minimal forbidden page. |
| `{ redirect: '/path' }` | `HTTP 302 Location: /path`. |
| *(throws)* | `HTTP 500` with the error message — policy code that crashes is not an implicit allow. |
| *(returns an invalid value)* | `HTTP 500` with a diagnostic message. |

The check runs:

1. **After** identity resolution (so `ctx.identity` is the resolved session identity or `ANONYMOUS`).
2. **After** binding lookup (so `require` only runs for valid routes).
3. **Before** the loader and before the default read (denied requests never fetch data — authorization always precedes data access).
4. **Before** any render path (forbidden users see the 403 page, not the component).

### Usage examples

**Anonymous → login redirect:**

```ts
bind(decision, [{
  component: Dashboard,
  view: 'list',
  config: {
    require: (ctx) =>
      ctx.identity.id === 'anonymous' ? { redirect: '/login' } : true,
    loader: async (ctx) => { /* ... */ },
  },
}]);
```

**Require active tier (the Perspicuity case):**

```ts
bind(journey, [{
  component: DashboardBinding,
  view: 'list',
  config: {
    require: async (ctx) => {
      if (ctx.identity.id === 'anonymous') return { redirect: '/api/auth/login' };
      const page = await ctx.read('member', { where: { oidc_subject: ctx.identity.id } });
      const member = (page as { records: Array<{ tier?: string }> }).records[0];
      if (!member || member.tier === 'none') return { redirect: '/activate' };
      return true;
    },
    loader: async (ctx) => { /* ... */ },
  },
}]);
```

**Admin-only panel:**

```ts
bind(adminEntity, [{
  component: AdminPanel,
  view: 'list',
  config: {
    require: (ctx) => ctx.identity.roles.includes('admin') || false,
  },
}]);
```

### Why not declarative rules?

Earlier drafts considered a declarative shape: `require: { tier: 'active', roles: ['member'] }`. Rejected because tier semantics are app-specific. The framework would have to grow a rule vocabulary (roles, tiers, custom claims, ownership, group membership, quota-based gates) and every consumer would need to learn which primitives the framework understood and which required a custom check. A function is the universal escape hatch — apps compose whatever logic they need, including reusing helpers across bindings.

### Composition with loaders

`require` and `loader` are independent hooks with the same context shape. Consumers who need the same data for both can either:

- **Duplicate the lookup.** Fast, obvious, one extra SQLite query. Fine for most cases.
- **Hoist into a shared helper.** `resolveMember(ctx)` lives in the app, called from both `require` and `loader`.

The framework does not cache across hooks. A future ADR could add a `ctx.once()` pattern if measurement shows it matters; there's no evidence yet.

## Data flow summary

```
Request: GET /journeys
  ↓
page-handler resolves identity from session cookie → identity
  ↓
binding = registry.bindingIndex.byEntityAndView('journey', 'list')
  ↓
┌─────────────────────────────────────────────────────────────────┐
│ IF binding.config.require:                                     │
│   ctx = LoaderContext { identity, url, request, params,         │
│                         read, dispatch }                        │
│   result = await require(ctx)                                   │
│   - true              → fall through                            │
│   - false             → return 403 forbidden page               │
│   - { redirect: URL } → return 302 Location: URL                │
│   - throws            → return 500 error page                   │
└─────────────────────────────────────────────────────────────────┘
  ↓ (only when require returns true — or was not set)
loader OR default read (ADR-12d path)
  ↓
renderPage (shell or full-page per ADR-12e)
  ↓
document template (theme, fonts, __JANUS__ per ADR-12c)
```

No new pipeline stages. No new entity types. `require` is a consumer-provided function that runs in the page handler.

## Migration

**Backward compatibility.** `require` is optional. Every existing binding renders byte-identical HTML without setting it. Middleware-based auth keeps working; consumers migrate at their own pace.

**Adoption for Perspicuity:**

1. Add `require` to `journeyBinding`:
   ```ts
   require: async (ctx) => {
     if (ctx.identity.id === 'anonymous') return { redirect: '/api/auth/login' };
     const memberPage = await ctx.read('member', {
       where: { oidc_subject: ctx.identity.id },
     }) as ReadPage;
     const member = memberPage.records[0];
     if (!member || member.tier === 'none') return { redirect: '/activate' };
     return true;
   }
   ```
2. Delete the `server.use('/journeys', requireActiveMember)` and `server.use('/journeys/*', requireActiveMember)` lines in `serve.ts`. The binding enforces them now.
3. Repeat for the decision detail binding once Phase 7 migrates that page.

**Adoption for new apps.** Declare `require` from day one; never write a per-route middleware for page auth. Middleware stays for cross-cutting concerns (logging, rate limits).

## Implementation notes

Files changed:

1. `packages/core/types.ts` — add `BindingRequireResult`, `BindingRequire` types; add `require?: BindingRequire` to `BindingConfig`.
2. `packages/core/index.ts` — export `BindingRequireResult`, `BindingRequire`.
3. `packages/core/bind.ts` — carry `require` through the frozen config.
4. `packages/http/page-handler.ts` — new `runRequire` helper building a `LoaderContext` with identity-threaded `read` / `dispatch`; check runs after identity resolution, before loader / default read; new `renderForbiddenPage` for `false` returns.
5. `packages/http/__tests__/route-policy.test.ts` (new) — 8 tests covering allow, deny, redirect, async, `ctx.read` integration, errors, loader-not-invoked-on-deny, anonymous-to-login pattern.

LOC: +80 in `@janus/core` + `@janus/http`, +230 tests. Strictly additive.

## Open Questions

1. **Reuse of `LoaderContext` type.** `require` receives the same context shape as a loader. That's convenient (one type to learn) but semantically mixed — `ctx.read` in a policy check is doing a different job than `ctx.read` in a loader. Could evolve into a separate `RequireContext` (without `params`, or with a read-only subset) later; no evidence yet that we need the split. Deferred.

2. **Caching resolved-member across `require` and `loader`.** Both will commonly look up the current user's member record. A request-scoped cache would halve the round trips. Deferred — measure first.

3. **Observability.** Policy denials don't emit an observable event. If/when binding-level access becomes an auditable dimension, add a `policy:deny` emit. Deferred.

4. **Typed redirect vs. URL strings.** `{ redirect: '/activate' }` is a raw path. Future apps might want to build redirects symbolically (`{ redirect: { to: 'activate' } }` resolving through a named-route table). Deferred; not evidence-driven yet.

## Resolved Questions

### Why a predicate instead of a declarative rule set?

Tier, role, ownership, and membership semantics are app-specific. A framework-side rule language would either under-cover real apps or balloon into its own mini-DSL. A predicate covers every case with one concept and lets apps reuse helpers across bindings.

### Why does `false` mean 403 and not "redirect to default login"?

`false` is the simple deny — for cases where the user shouldn't be redirected anywhere (e.g., an admin-only page accessed by a non-admin). Apps that want "deny → login" return `{ redirect: '/login' }` explicitly. Framework stays policy-agnostic.

### Why doesn't the framework distinguish "unauthenticated" from "unauthorized"?

It could, via a discriminated union like `{ unauthenticated: true }` vs `{ forbidden: true }`. Rejected: the caller already knows which one it's doing (it has `identity` in hand). Adding a type distinction gains nothing the return shape can't express, and multiplies the framework's contract surface.

### Why does `require` throwing produce 500 and not deny?

Authorization code that crashes is a bug. Interpreting a crash as an implicit deny would silently hide the bug; interpreting it as an implicit allow would open the page. 500 surfaces it without making the wrong policy decision.

### Does this replace entity-level policy (ADR-05)?

No. Entity-level policy governs `dispatch()` calls — API reads, writes, mutations. `require` governs page-rendering access. Both run: an admin-only panel can declare `require: isAdmin`, and its underlying entity can still have `policy: { rules: ... }` for the API surface. Independent layers.

## Implications

- Closes the third of four gaps identified in `perspicuity/docs/janus-binding-gaps.md`. BLD (12d) + BVL (12e) + BRP (12f) now cover the full shape Perspicuity needs.
- Removes the "hand-wire middleware per route" burden from consumer apps. Gates live with views.
- Sets up Phase 6 in the rollout plan: Perspicuity deletes `requireActiveMember` from `serve.ts` and moves the gate onto its bindings.
- Establishes bindings as the place where access rules live alongside rendering and data. Future concerns on the same seam (audit, rate limit, feature flags) fit the same pattern.
