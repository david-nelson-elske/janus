# 124-12c: Consumer Rendering Hooks

**Status:** Draft
**Date:** 2026-04-20
**Depends on:** [10](10-presentation-and-binding.md) (Binding Model), [12b](12b-client-entity-cache.md) (Rendering Infrastructure), [08](08-http-surface-and-bootstrap.md) (HTTP Surface)
**Package:** `@janus/http`

## Scope

This sub-ADR specifies the three hooks that let a consumer app customize what the framework's binding-driven SSR renders, without abandoning the framework for hand-written routes:

1. **Theme** — inject consumer CSS, fonts, title, and `<head>` content into the rendered document.
2. **Layout shell** — replace the framework's hardcoded `<nav>` + `<main>` structure with a consumer-provided wrapper, nav, and footer.
3. **List-view query parameters** — let list pages read `?where.X=Y`, `?limit`, `?offset`, `?sort`, and `?search` from the URL and pass them through to the entity read.

This sub-ADR does NOT cover:
- Multi-entity page compositions (listing + tag_assignments + affiliate_links on one view) — see future "multi-binding pages" work.
- Full client-side hydration — see [12b](12b-client-entity-cache.md).
- CSS Modules, Tailwind integration, or any specific styling framework — consumers bring their own CSS as strings or URLs.
- Dynamic runtime theme switching (light/dark user preference) — theme is compile-time config; runtime switching is the consumer's problem.

## Context

[ADR-10](10-presentation-and-binding.md) defines bindings as the third wiring domain — entities bound to components so the framework serves `/listings` and `/listings/:id` automatically via `createApp({ enablePages: true })`. The current implementation works end-to-end:

- `dev-app` uses bindings for every page it serves (`/adr`, `/tasks`, `/questions`).
- `perspicuity` uses bindings for its decision index + detail views.

But three real consumer apps have bypassed the binding path:
- **community-association** never declares `bind()` and hand-writes every route in `routes/*.ts`.
- **balcony-solar** declares 6 bindings in `src/bindings.ts` and then **never uses them** — `src/admin-routes.ts` (107 KB) reimplements every detail and list page with custom Hono handlers and Preact components.
- **directory-listings / find-my-next-bite** (this repo's cohort) is about to make the same choice if we don't close these gaps.

The pattern is not laziness. It's the framework's current rendering surface being too small for any app that needs a brand, a filterable list, or a custom layout.

### What the framework currently bakes in

`packages/http/ssr-renderer.ts:60-86` — the `renderDocument()` function:

```ts
function renderDocument(appHtml, initData, title): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ...
  <link href="https://fonts.googleapis.com/css2?family=Inter:..&family=JetBrains+Mono:..&display=swap" ... />
  <style>${CSS_RESET}${APP_STYLES}</style>
</head>
<body>${appHtml}...</body>
</html>`;
}
```

The function hardcodes:
- **Fonts** — Inter + JetBrains Mono from Google Fonts.
- **Palette** — Linear-inspired dark theme (`#d4d4d8` text on `#09090b` background, teal `#2dd4bf` links). About 280 lines of CSS in `APP_STYLES`.
- **Title** — `"Janus"` by default.
- **Shell structure** — the `.janus-nav` + `.janus-main` wrapper is rendered by `ssr-renderer.ts` around the component's output; consumers can't change it.

`packages/http/page-handler.ts:56-58` — the list view read:

```ts
const response = await runtime.dispatch('system', route.entity, 'read', {}, identity);
```

Always `{}`. No query parameters reach the dispatch. Every list is an unfiltered, unsorted, unpaginated read of everything.

### Why this blocks real apps

- A food directory without forest-green + cream branding isn't *Find My Next Bite*; it's someone else's website with our data.
- A solar installer directory without `?state=ca` filtering can't serve state-scoped pages, which is core UX.
- Any app with a custom nav (auth-aware, logo, menu items) has to replace the full rendering path, not just the shell.

These aren't separate problems — they're the same missing layer: consumer hooks on a rendering pipeline that otherwise does everything right.

## Decision

Three hooks on `AppConfig`, all opt-in, all with sensible defaults that preserve current behavior.

### 1. Theme

```ts
export interface ThemeConfig {
  /** Inline CSS appended after the framework reset. Consumer styles win by source order. */
  readonly css?: string;

  /** External stylesheet URL(s). Loaded with <link rel="stylesheet">. */
  readonly cssUrl?: string | readonly string[];

  /** Font configuration. When set, replaces the default Inter + JetBrains Mono <link>s. */
  readonly fonts?: ThemeFontsConfig;

  /** Default document title. Overridden per page by the binding when it provides one. */
  readonly title?: string;

  /** Additional <head> content — favicon, meta tags, analytics snippets. Rendered as-is. */
  readonly headExtras?: string;

  /** <html lang> attribute. Default: 'en'. */
  readonly lang?: string;
}

export interface ThemeFontsConfig {
  /** Stylesheet href (e.g. a Google Fonts URL). */
  readonly href: string;
  /** Hosts to preconnect to. Default: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] */
  readonly preconnect?: readonly string[];
}
```

Passed to `createApp`:

```ts
const app = await createApp({
  declarations: [...],
  theme: {
    css: THEME_CSS,              // consumer's whole stylesheet
    fonts: {
      href: 'https://fonts.googleapis.com/css2?family=Inter:..&family=Playfair+Display:..&display=swap',
    },
    title: 'Find My Next Bite',
    headExtras: `<link rel="icon" href="/public/logo.svg" type="image/svg+xml">`,
  },
});
```

**Behavior:**
- The framework's `CSS_RESET` stays (universal concerns: box-sizing, font smoothing, sensible defaults on `body`).
- The framework's `APP_STYLES` (the Linear-inspired styles) becomes **opt-out** — when `theme.css` is provided, `APP_STYLES` is NOT emitted. The consumer is responsible for styling `.janus-nav` + `.janus-main` (or, with hook 2, replacing them entirely).
- When `theme.fonts` is provided, the default font `<link>`s are replaced. Otherwise, the default Inter + JetBrains Mono is served.
- `theme.headExtras` is rendered inside `<head>` after fonts + stylesheets, before the closing `</head>`. No escaping — consumer's responsibility.

**Rationale for opt-out `APP_STYLES`:** keeping the default CSS when consumer CSS is provided leads to specificity wars. Apps that want minor tweaks can copy the relevant defaults into their own CSS; apps that want a rewrite get a clean slate.

### 2. Layout shell

```ts
export interface LayoutConfig {
  /**
   * Full-page wrapper component. Receives children (the entity component's output)
   * plus contextual data (current path, identity).
   * Defaults to the framework's <nav> + <main> structure.
   */
  readonly shell?: ComponentType<{
    children: preact.VNode;
    path: string;
    identity: Identity;
    registry: CompileResult;
  }>;

  /**
   * Suppress the framework's default nav entirely without providing a shell.
   * Consumer handles navigation via their own CSS / entity component.
   */
  readonly suppressDefaultNav?: boolean;
}
```

**Behavior:**
- When `layout.shell` is provided, it wraps the entity component's output. The shell receives:
  - `children` — the rendered binding component (list or detail)
  - `path` — the current request path
  - `identity` — the resolved identity (ANONYMOUS or a user)
  - `registry` — for introspecting available bindings (e.g. to build nav links from entity list)
- When only `layout.suppressDefaultNav` is set (and `layout.shell` is undefined), the framework renders the binding component naked inside `<body>`. Consumer CSS drives everything.
- Either option replaces the current hardcoded `<nav class="janus-nav">…</nav><main class="janus-main">…</main>`.

**Shell defaults.** The framework ships a reference shell that can be imported and composed:

```ts
import { defaultShell, defaultNav } from '@janus/http/shells';

const layout = {
  shell: ({ children, registry, identity }) => (
    <MyWrapper>
      {defaultNav({ registry, identity })}
      <main>{children}</main>
      <MyFooter />
    </MyWrapper>
  ),
};
```

Apps that just want a custom nav on top of the framework's default `<main>` use the reference shell and swap the nav; apps that want everything custom write their own from scratch.

### 3. List-view query parameters

Extend `page-handler.ts` to parse URL query parameters into the list-view dispatch.

#### Reserved params (framework-owned)

| Param | Effect | Example |
|---|---|---|
| `limit` | Passed as `limit` to the read | `?limit=20` |
| `offset` | Passed as `offset` | `?offset=40` |
| `sort` | Passed as `sort` array (comma-separated: `field` asc, `-field` desc) | `?sort=-createdAt,name` |
| `search` | Passed as `search` for FTS (pipeline routes this to FTS if the entity has `searchable` fields) | `?search=ramen` |

#### Where clause params

Any URL param with the prefix `where.` is parsed into a `where` object passed to the dispatch.

| Query | Becomes |
|---|---|
| `?where.status=published` | `{ where: { status: 'published' } }` |
| `?where.facet=cuisine&where.active=true` | `{ where: { facet: 'cuisine', active: true } }` |
| `?where.priceRange=%24%24` | `{ where: { priceRange: '$$' } }` |

Values are passed through as strings except for the literal tokens `true` / `false` / `null`, which are coerced to their JS equivalents. Numeric coercion is deliberately not automatic — entity fields with `Int` types get their string values, and the validate concern handles type coercion (same path as API requests today).

Unknown params (not `limit`/`offset`/`sort`/`search` and not prefixed with `where.`) are ignored. No errors; the framework is permissive about query-string noise.

#### Security note

The `where` object is passed to the existing dispatch pipeline. The pipeline's policy concern enforces visibility — passing `?where.ownerId=someone-else` on an owner-scoped entity will be denied by the policy handler, same as it would via the API. No new authorization surface.

## Data flow summary

```
Request: GET /listings?where.status=published&sort=-createdAt&limit=20
  ↓
page-handler parses URL → { route: list of 'listing', params: { where, sort, limit } }
  ↓
dispatch('system', 'listing', 'read', params, identity) [existing pipeline — unchanged]
  ↓
binding.component({ page, records })
  ↓
ssr-renderer renders document:
  - lang from theme.lang
  - title from theme.title (or binding-provided override)
  - fonts from theme.fonts (or defaults)
  - headExtras from theme.headExtras
  - inline <style>: CSS_RESET + (theme.css || APP_STYLES)
  - <body>: layout.shell ? shell(component) : default nav + main wrapper
```

No new pipeline stages. No new entity types. Everything is optional config on the existing `createApp`.

## Migration

**Backward compatibility:** every field added by this ADR is optional. Apps that don't set `theme` or `layout` get today's behavior bit-for-bit. `dev-app` and `perspicuity` keep working unchanged.

**Adoption path for balcony-solar and similar:**

1. Declare bindings (already done in balcony-solar).
2. Pass a `theme` object with the existing stylesheet.
3. Pass a `layout.shell` that replicates the custom nav currently hand-written.
4. Delete the hand-written route factories one at a time as bindings cover their use case.

Expected LOC delta for balcony-solar once migrated: `src/admin-routes.ts` shrinks from ~2,465 lines to (estimate) <500 lines of custom admin flows that really are multi-entity or bespoke.

**Adoption for directory-listings (drives this ADR):** the path becomes bind-declare-theme-ship. We don't even have hand-written routes to delete yet — we never write them.

## Implementation notes

Six files changed:

1. `packages/http/create-app.ts` — add `theme` and `layout` to `AppConfig`; pass through.
2. `packages/http/hono-app.ts` — accept `theme` and `layout` in `CreateHttpAppConfig`; pass to `createPageHandler`.
3. `packages/http/page-handler.ts` — parse URL query params into dispatch input; accept + forward theme/layout.
4. `packages/http/ssr-renderer.ts` — `renderDocument()` gains theme and layout args; `APP_STYLES` becomes conditional; shell wrapper becomes overridable.
5. `packages/http/shells.ts` (new) — export `defaultShell` and `defaultNav` for composition.
6. `packages/http/index.ts` — add public exports for `ThemeConfig`, `LayoutConfig`, `defaultShell`, `defaultNav`.

New tests in existing files:
- `ssr-renderer.test.ts` — theme overrides, headExtras rendering, opt-out of APP_STYLES.
- `page-handler.test.ts` — list view with `where.*`, `limit`, `sort`; where clause flows to dispatch.
- `hono-app.test.ts` — layout shell replaces default; suppressDefaultNav works.

Estimated LOC: +250 in `@janus/http`, +150 tests.

## Open Questions

1. **Per-view theme overrides.** A public listings page and an admin page in the same app might want different themes. Deferred — for now, one theme per app. Consumers can split into two `createApp` calls on different ports if they really need it.

2. **Shell as Preact component vs. shell as function returning a string.** Going with component — keeps it composable with the rest of the Preact tree. The function-returning-string alternative was simpler but broke client-side hydration plans in ADR-12b.

3. **Default nav's entity filter.** Today it shows every entity with a list binding. Should `layout.suppressEntityNav` separately exist for apps that want the default shell but a curated nav? Revisit if a consumer hits this.

4. **`where.in` / `where.ne` / `where.contains` operators.** Query param syntax for operators beyond equality. The existing entity read pipeline supports these; we just need a URL encoding convention. Deferred — equality filtering covers our Phase 1 needs. Suggested follow-up: `?where.status.in=draft,published`.

## Resolved Questions

### Should we deprecate `APP_STYLES` entirely?

No. `dev-app` and `perspicuity` rely on it. Keep as the default when no consumer theme is provided.

### Should `theme.css` *replace* the reset or be *appended* after it?

Appended. Box-sizing and font-smoothing defaults are universal enough to be non-negotiable; consumers who want to override can do so via their own CSS.

### Should this be `@janus/http` or a new `@janus/ui` / `@janus/theme` package?

Stays in `@janus/http`. These hooks are specifically about how the HTTP surface renders entity bindings. No value in splitting out; adds workspace noise.

### Does ADR-10 move from Draft → Accepted with this ADR?

Partially. [10](10-presentation-and-binding.md) still has unaddressed items (multi-entity pages, dynamic slot composition — Decision 20 in ADR-124). This ADR clears the consumer-facing adoption blockers but doesn't close 10 entirely.

## Implications

- Unblocks `find-my-next-bite` and `rooftop-solar` to ship binding-driven (no hand-written pages). This is the specific driver for this ADR.
- Provides a migration path for balcony-solar to delete the bindings-declared-but-bypassed anti-pattern.
- Removes Linear-theme lock-in from any binding-using app. Consumers can ship branded sites on janus without exiting the framework.
- The `defaultShell` / `defaultNav` exports become a stable API surface — changing them is a breaking change for consumers who compose.
- Sets up the architectural shape for a future `layout.slots` model (named slots the entity component can target), but does not commit to it here.
