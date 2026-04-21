# 124-12e: View-Owned Layout

**Status:** Draft
**Date:** 2026-04-21
**Depends on:** [10](10-presentation-and-binding.md) (Binding Model), [12c](12c-consumer-rendering-hooks.md) (Consumer Rendering Hooks), [12d](12d-binding-loaders.md) (Binding Loaders)
**Package:** `@janus/core`, `@janus/http`

## Scope

This sub-ADR adds a single opt-in to `BindingConfig` that lets a binding bypass the app-level shell and own the full viewport for a given view.

- **`config.renderMode: 'full-page'`** — when set, the framework does not wrap the component output in `DefaultShell`, `MinimalShell`, or a consumer-provided `layout.shell`. The component renders straight into `<body>` and is handed the props it needs to build its own chrome (`path`, `identity`, `registry`).

This sub-ADR does NOT cover:

- **Named slots on the shell** (e.g. `shell.leftRail`, `shell.rightRail` that a view fills). Slots were considered and rejected — see Resolved Questions.
- **Dynamic runtime switching between shell and full-page**. `renderMode` is compile-time config; swapping chrome per request is not supported.
- **Declarative route policy** (BRP) — tier/role gates on bindings. Separate ADR, tracked in the Perspicuity rollout plan.
- **Client-side routing between full-page views**. Each request still produces a full SSR response.

## Context

[ADR-12c](12c-consumer-rendering-hooks.md) added `layout.shell`: a consumer-provided wrapper component that receives `children` + contextual props. It lets apps swap out the framework's default nav/main without exiting the binding system. That's the right answer for app-level chrome (header, footer, brand) — one shell, every page.

It is not enough for apps whose pages have **different layouts from each other.**

### Why `layout.shell` is not enough

`ShellProps` has exactly one slot: `children`. The shell wraps the component's output. That works when every page has the same chrome and just different center content — a list here, a detail there. It breaks when pages have structurally different layouts:

- A **dashboard** with a left rail showing a journey tree, a center list, and a credit balance in the corner.
- A **decision detail page** with steps on the left, a chat stream in the center, and a live document preview on the right.
- A **landing page** with a hero, full-width sections, no nav at all.

Perspicuity's `src/pages.ts:92-100` (`renderPage`) demonstrates the shape real pages need:

```ts
export function renderPage(config: ShellConfig): string {
  const leftRailHtml = config.leftRail ?? renderDefaultLeftRail(...);
  const rightRailHtml = config.rightRail ?? '';
  const navHtml = renderNav({ identity, activePath, inShell: true });
  // ... renders a three-pane layout: nav + leftRail + center + rightRail
}
```

`{ center, leftRail, rightRail, title, activeNav, journeys, identity }` — page-aware chrome, not app chrome. One `shell` slot can't host this.

### What the framework could do about it

Two architectural options:

**Option A — grow `ShellProps` into a slot system.** Add `leftRail`, `rightRail`, named slots. Shells declare which slots they accept; views declare which they fill.

Rejected. The slot set is open-ended (three-pane, four-pane, tabbed, full-bleed, dashboard grids). Every new layout pattern adds a slot. The framework ends up defining every UI archetype the ecosystem might want — a losing game.

**Option B — let specific views opt out of the shell entirely.** The app-level shell still covers the common case; views that need something different skip it and own their viewport.

Chosen. Smaller surface area. The framework handles routing, data loading (via BLD), identity, authorization, SSR mount, and hydration — but stops short of imposing a layout on views that need to differ. Layouts are *part of* a view; extracting them into the framework was the overreach.

## Decision

Add `renderMode` to `BindingConfig`:

```ts
export type BindingRenderMode = 'shell' | 'full-page';

export interface BindingConfig {
  // ...existing fields (fields, columns, layout, title, loader)
  readonly renderMode?: BindingRenderMode;
}
```

### Behavior

| `renderMode` | Effect |
|---|---|
| `'shell'` (or omitted) | Component output is wrapped in `layout.shell` → `MinimalShell` → `DefaultShell`, in that order (pre-12e behavior). |
| `'full-page'` | No shell wrap. Component output is rendered directly into `<body>`. The component receives `path`, `identity`, and `registry` as props (in addition to the usual `contexts` / `fields` / `config` / `data`). |

The document template — `<html lang>`, `<head>` with fonts, theme CSS, `__JANUS__` hydration — still wraps every page regardless of `renderMode`. Only the body-level shell wrap is skipped.

### Component props in full-page mode

```ts
// Component signature for a full-page list view with a loader.
type FullPageListProps<TData> = {
  data?: TData;             // from loader (ADR-12d)
  contexts?: readonly BindingContext[]; // empty when using a loader
  context?: BindingContext; // empty when using a loader
  fields?: FieldBindings;
  config: BindingConfig;
  path: string;             // request path — use for nav highlighting
  identity: Identity;       // resolved from session
  registry: CompileResult;  // for introspecting available bindings
};
```

The full prop set is a superset of shell-mode props. Components written for shell mode keep working if switched to full-page — they just receive extra props they can ignore.

### When to use full-page

Rule of thumb: if the view needs to render above `<main>` — nav, left rail, header with page-specific state — use full-page. If it only needs to fill center content, keep the default (shell). The shell is for "the same chrome on every page;" full-page is for "this view is structurally different."

## Data flow summary

```
Request: GET /dashboard
  ↓
page-handler resolves identity, route, binding (unchanged)
  ↓
optional: binding.config.loader → data (ADR-12d, unchanged)
  ↓
renderPage(...)
  ↓
┌──────────────────────────────────────────────────────────────┐
│ IF binding.config.renderMode === 'full-page':               │
│   vnode = <Component contexts context fields config data     │
│                      path identity registry />               │
│   appHtml = renderToString(vnode)                            │
│   (no shell, no wrapper)                                     │
│                                                              │
│ ELSE (shell path — pre-12e, unchanged):                     │
│   vnode = <Component contexts context fields config data />  │
│   shellProps = { children: vnode, path, identity, registry }│
│   Shell = layout.shell ?? MinimalShell ?? DefaultShell      │
│   appHtml = renderToString(<Shell ...shellProps/>)           │
└──────────────────────────────────────────────────────────────┘
  ↓
renderDocument wraps appHtml with <html>/<head>/<body>/<script>
                        (theme CSS, fonts, __JANUS__)
```

Every existing piece — theme CSS, font links, hydration blob, consumer `headExtras`, `<title>` composition — runs identically regardless of `renderMode`. The only branch is whether the shell wraps the component output.

## Migration

**Backward compatibility.** `renderMode` is optional. Every existing binding renders byte-identical HTML without setting it.

**Adoption for perspicuity** (the driver):

1. Set `renderMode: 'full-page'` on the `journeyBinding` landed in Phase 2.
2. Update `DashboardBinding` to render Perspicuity's top nav + left rail + credit balance in addition to the journey list — the same chrome `renderDashboardPage` produces today. Use the existing `renderNav` / `renderDefaultLeftRail` helpers from `src/nav.ts` and `src/pages.ts`; no duplication.
3. The `/journeys` URL now renders with full visual parity to `/decisions`. Ship.
4. Repeat for the decision detail binding once it migrates to BLD.

**Adoption for other consumers.** Any app that today embeds app-level chrome (nav, rails) in `layout.shell` stays put — shell mode is still the default. Only views that need structurally different layouts opt in.

## Implementation notes

Files changed:

1. `packages/core/types.ts` — add `BindingRenderMode` type; add `renderMode?: BindingRenderMode` to `BindingConfig`.
2. `packages/core/index.ts` — export `BindingRenderMode`.
3. `packages/core/bind.ts` — carry `renderMode` through the frozen config.
4. `packages/http/ssr-renderer.ts` — branch on `binding.config.renderMode`; full-page path skips the shell and passes extra props to the component.
5. `packages/http/__tests__/view-owned-layout.test.ts` (new) — 7 tests covering skip-shell, default preserved, explicit `'shell'` equivalent, props threaded, document template still wraps, `layout.shell` also bypassed, loader composition.

LOC: +30 in `@janus/core` + `@janus/http`, +200 tests. Strictly additive.

## Open Questions

1. **Loader payload in `__JANUS__` for full-page views.** Today `serializeInitData` receives `contexts` only; the loader's `data` is not serialized into the hydration blob. For full-page views that want client-side interactivity past the initial SSR, this is a gap. Deferred — the current need is server-rendered parity; hydration extensions can follow once a real consumer hits the case.

2. **Full-page mode with `layout.shell` set.** Full-page bindings ignore the consumer's `layout.shell`. That's correct (the binding declared it wants the whole viewport), but it's an interaction worth being explicit about in the docs. Revisit if consumers build patterns where "most bindings use the shell, one uses full-page" produces surprising results.

3. **A middle ground: "bare" mode (no shell, minimal document).** Future consumers might want full-page mode but with a stripped-down `<head>` — no theme CSS, no fonts. Out of scope; revisit with evidence.

## Resolved Questions

### Why not named slots (`shell.leftRail`, `shell.rightRail`)?

The slot set is open-ended: three-pane, four-pane, tabbed, split view, full-bleed, dashboard grid, conversation layout. Every new layout the ecosystem wants means new slots. The framework ends up committing to specifying every UI archetype — the same trap "one shell to rule them all" already fell into. Full-page is the escape hatch that avoids the trap; pages that need structure the app-level shell can't express declare themselves out of the shell system entirely.

### Should full-page views receive a `theme` prop so they can read the consumer's branding tokens?

No. Theme is document-level — it lands in `<head>` via CSS. A full-page component styles itself with CSS that reads theme vars; there's no need to thread theme through props. Keeping components styled via CSS (not inline) is the right convention.

### Should the existing `layout.suppressDefaultNav` be deprecated in favor of per-binding full-page?

No. `suppressDefaultNav` is app-level — suppresses nav on every page. Full-page is per-view. Different granularity; different use case. They coexist.

### Does this supersede ADR-10's presentation model?

No. ADR-10 defines bindings as entity-to-component mapping. This ADR is about where that component renders in the document. Both layers continue as specified.

## Implications

- Closes the second of four gaps identified in `perspicuity/docs/janus-binding-gaps.md`. BLD (12d) gave Perspicuity data composition; BVL (12e) gives it the chrome control it needs to ship `/journeys` at visual parity with `/decisions`.
- Removes the "always wrap in a shell" assumption from the binding rendering path. Future consumer UIs are no longer constrained by the framework's layout opinions.
- Sets up BRP (declarative route policy on bindings) as the last prerequisite before the Phase 4+ migration: Perspicuity deletes `renderDashboardPage`, then `renderDocumentPage`, and flips `enablePages: true`.
- Establishes that per-binding rendering modes are a thing. If a future consumer wants "render this binding as a PDF" or "render this binding as JSON only," the `renderMode` enum is the place to grow.
