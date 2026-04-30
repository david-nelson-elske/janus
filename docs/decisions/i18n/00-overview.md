# 125-00: I18n Architecture (Overview)

**Status:** Draft
**Date:** 2026-04-30
**Depends on:** ADR-124 (Participation Model), specifically 124-08 (HTTP Surface) and 124-10 (Presentation & Binding)
**Owner:** TBD
**Implementation issue:** TBD

---

## Scope

Bake first-class internationalization into Janus so any application gets multilingual support out of the box, end-to-end:

- **Request-time language resolution** — cookie, URL path prefix, or `Accept-Language` header, threaded into the SSR render context.
- **String catalog** — `t(key)` translator backed by [`i18next`](https://www.i18next.com/), with per-app translation JSON files.
- **Translatable entity fields** — a `Translatable(field)` wrapper in the vocabulary that auto-provisions per-language storage columns and a language-aware read accessor.
- **HTML correctness** — `<html lang>`, `hreflang` alternates, and a built-in language switcher component the shell exposes.
- **CI/build hygiene** — translation key parity check, missing-translation reporter.

Localization beyond translation (date/number/currency formatting, plural rules, RTL layouts) is in scope at the library level (we get it from `i18next` + `Intl` for free), but we don't add Janus-specific abstractions for it until a concrete app needs them.

The first consumer is **balcony-solar** (`pluginsolarpower.ca`) for its Quebec campaign. The architecture is designed so any future Janus app gets bilingual-by-default with three lines of bootstrap.

## Motivation

balcony-solar is a Canada-wide advocacy site that needs a French companion of every public page before the Quebec campaign can credibly run. The first cut of i18n was prototyped in-app (`balcony-solar/src/lib/lang.ts`, commits 9c75c70, 524785b, 796e914 — cookie-based language selection, slogan-only translation, hand-rolled `t()` substitute).

That prototype proves the seam (request → lang context → component reads lang) is correct, but the implementation belongs in the framework, not in the app, for three reasons:

1. **Reuse.** Every Janus app that has a Canadian (or any multi-language) audience will hit the same problem. A single `import { useT } from '@janus/i18n'` ships them the solution.
2. **Library leverage.** The hand-rolled lookup doesn't handle pluralization, interpolation, or namespaces — which we will need the moment we translate "1 signature" vs "12 signatures." Wrapping `i18next` in a Janus-shaped API gets us the hard parts of i18n for free without locking apps into i18next's full surface.
3. **Storage layer integration.** Translatable DB content (article body, news headline, FAQ answer) needs schema support. Doing this once in `@janus/vocabulary` + `@janus/store` is far cleaner than every app reinventing the parallel-column or join-table pattern.

## Decision

Add three pieces to Janus, layered to match the existing dependency flow (`vocabulary → core → store/pipeline/client → http/agent/cli`):

```
┌─────────────────────────────────────────────────────────┐
│ @janus/i18n (NEW)                                       │
│   • i18next instance + resource loading                 │
│   • t() helper, useT() context hook                     │
│   • <LanguageSwitcher/> component                       │
│   • parity CI script                                    │
└─────────────────────────────────────────────────────────┘
                       │ consumed by
                       ▼
┌─────────────────────────────────────────────────────────┐
│ @janus/http (EXTEND)                                    │
│   • i18nMiddleware() — resolves lang per request        │
│   • ssr-renderer.ts — emits <html lang>, hreflang,     │
│       passes lang into SSR context                      │
│   • shells.ts — exposes language switcher slot          │
└─────────────────────────────────────────────────────────┘
                       │ data-layer hook
                       ▼
┌─────────────────────────────────────────────────────────┐
│ @janus/vocabulary (EXTEND)                              │
│   • Translatable<T extends Field>(base: T): Field       │
│     wraps a base field type, marks it as i18n-bearing   │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│ @janus/store (EXTEND)                                   │
│   • column provisioning: Translatable fields generate   │
│     parallel <name>_<lang> columns at compile-time      │
│   • read accessor: record.title returns the active-lang │
│     value, falls back to default-lang when null         │
│   • migration helper: add-language-column for existing  │
│     deployments                                         │
└─────────────────────────────────────────────────────────┘
```

### Package: `@janus/i18n` (NEW)

New workspace package at `packages/i18n/`.

#### Public API

```ts
// packages/i18n/index.ts

export interface I18nConfig {
  /** Supported language codes. First is the default. */
  langs: readonly string[];
  /** Default language (must be in `langs`). */
  defaultLang: string;
  /** Path to translation resource directory.
   *  Expected layout: <dir>/<lang>.json (e.g., lang/en.json, lang/fr.json). */
  resourcesDir: string;
  /** How to resolve language per request. Default: ['cookie','accept-language']. */
  resolvers?: readonly LangResolver[];
  /** Cookie name used by 'cookie' resolver. Default: 'lang'. */
  cookieName?: string;
  /** URL path prefix for 'path' resolver. When set, /<prefix>/<rest> is treated
   *  as the FR mirror of /<rest>. Default: undefined (path resolver disabled). */
  pathPrefix?: Record<string, string>;        // { fr: '/fr' }
}

export type LangResolver = 'cookie' | 'path' | 'accept-language' | 'query';

export interface I18nInstance {
  /** Hono middleware. Sets c.var.lang and c.var.t. */
  middleware(): MiddlewareHandler;
  /** Translate a key for a specific lang. */
  t(key: string, lang?: string, opts?: TFuncOptions): string;
  /** All configured languages. */
  langs: readonly string[];
  /** Default language. */
  defaultLang: string;
  /** Build a switch URL for the current path. */
  switchHref(currentPath: string, targetLang: string): string;
}

export function createI18n(config: I18nConfig): Promise<I18nInstance>;

/** SSR component-side helper. Reads lang from the render context. */
export function useT(): (key: string, opts?: TFuncOptions) => string;
export function useLang(): string;

/** Server-rendered language switcher. */
export interface LanguageSwitcherProps {
  readonly currentPath: string;
  readonly currentLang: string;
  readonly variant?: 'inline' | 'dropdown';   // default 'inline'
  readonly className?: string;
}
export function LanguageSwitcher(props: LanguageSwitcherProps): VNode;

/** CI helper — fails non-zero if translation files have key drift. */
export function checkParity(resourcesDir: string): { ok: boolean; missing: Record<string, string[]> };
```

#### Resource file format

```json
// app/lang/en.json
{
  "nav": {
    "takeAction": "Take Action",
    "blog": "Blog",
    "regulations": "Regulations"
  },
  "hero": {
    "slogan": "Power your balcony, not your bill"
  },
  "petition": {
    "consent": {
      "advocacy": "I consent to receive campaign updates",
      "advocacy_count_one": "{{count}} person has signed",
      "advocacy_count_other": "{{count}} people have signed"
    }
  }
}
```

```json
// app/lang/fr.json — must have identical keys (CI-enforced)
{
  "nav": { "takeAction": "Agir", "blog": "Blogue", "regulations": "Réglementation" },
  "hero": { "slogan": "Alimentez votre balcon, pas votre facture" },
  "petition": {
    "consent": {
      "advocacy": "Je consens à recevoir des mises à jour de la campagne",
      "advocacy_count_one": "{{count}} personne a signé",
      "advocacy_count_other": "{{count}} personnes ont signé"
    }
  }
}
```

i18next plural keys (`_one`, `_other`, `_zero`, etc.) handle pluralization; nested keys give us namespacing without ceremony.

#### Dependency choice: `i18next`

**Why `i18next` over `formatjs`/`lingui`/roll-our-own:**

- **Plural rules** for French differ from English — `i18next` resolves them via CLDR (built into the lib).
- **Interpolation + nesting** — `{{count}}`, `{{name}}`, `$t(other.key)` reference patterns work out of the box.
- **JSON resource format** is the de facto standard for translation tooling (Crowdin, Lokalise, Phrase, DeepL Pro). Lowers friction when we engage paid translators.
- **No framework lock-in** — `i18next` has no opinion on our SSR/Preact/Hono stack. Its core is plain JS.
- **Bundle cost** — `i18next` core is ~14KB minified; we don't ship `i18next-react` or detector plugins, so the SSR-only footprint is small.

**Rejected alternatives:**
- `lingui` — JSX-build-time extraction is appealing but ties us to a babel/vite plugin that doesn't fit Bun/Hono cleanly.
- `formatjs` / `Intl.MessageFormat` — purer (browser-native plural rules), but the catalog format (`messages.json` with ICU strings) is harder for human translators to read.
- Roll-our-own — workable for ~50 strings, painful at 500+ once pluralization and interpolation hit. We move now, not later.

### Package: `@janus/http` (EXTEND)

#### Middleware

`packages/http/i18n-middleware.ts` (new file):

```ts
export function createI18nMiddleware(i18n: I18nInstance): MiddlewareHandler {
  return async (c, next) => {
    const lang = resolveLang(c.req, i18n);
    c.set('lang', lang);
    c.set('t', (key: string, opts?: TFuncOptions) => i18n.t(key, lang, opts));
    await next();
  };
}

function resolveLang(req: HonoRequest, i18n: I18nInstance): string {
  for (const resolver of i18n.resolvers) {
    const candidate = runResolver(resolver, req, i18n);
    if (candidate && i18n.langs.includes(candidate)) return candidate;
  }
  return i18n.defaultLang;
}
```

Resolvers run in order: path prefix → cookie → query → Accept-Language → default. App configures the order.

#### SSR renderer integration

`packages/http/ssr-renderer.ts` extends to:
1. Read `c.var.lang` from the request context.
2. Make `lang` and `t` available via Preact context (`<LangContext.Provider value={lang}>`) — components consume via `useT()` / `useLang()` from `@janus/i18n`.
3. Emit `<html lang="...">` automatically (replace the current hardcoded `<html lang="en">` in shells.ts).
4. Emit `<link rel="alternate" hreflang="...">` for every supported language pointing at the matching path.

#### Shell extension

`packages/http/shells.ts` — the `BalconySolarShell` (and any future shell) accepts a `languageSwitcher` slot prop. By default the slot renders the framework's `<LanguageSwitcher/>`. Apps can override.

### Package: `@janus/vocabulary` (EXTEND)

Add a single field-type wrapper:

```ts
// packages/vocabulary/translatable.ts (new)

import type { SemanticField } from './semantic-types';

export interface TranslatableField<T extends SemanticField> {
  readonly kind: 'translatable';
  readonly base: T;
}

export function Translatable<T extends SemanticField>(base: T): TranslatableField<T> {
  return { kind: 'translatable', base };
}
```

Usage in a `define()` schema:

```ts
import { Translatable, Str, Markdown } from '@janus/vocabulary';

export const news = define('news', {
  schema: {
    title: Translatable(Str({ required: true })),
    body: Translatable(Markdown()),
    category: Enum(['analysis', 'policy']),     // not translatable
    date: DateTime(),                            // not translatable
  },
  // ...
});
```

The compiler (`@janus/core/compile.ts`) recognises `Translatable` and forwards both the field metadata AND the active language list to the storage layer.

### Package: `@janus/store` (EXTEND)

The store adapters (memory + SQLite + PostgreSQL) detect `TranslatableField<T>` at schema-compile time and provision parallel columns:

| Schema declaration | SQLite columns generated |
|---|---|
| `title: Translatable(Str())` with langs `['en','fr']` | `title`, `title_fr` |
| `body: Translatable(Markdown())` with langs `['en','fr','es']` | `body`, `body_fr`, `body_es` |

The default-language column keeps its original name (`title`, no suffix); other languages get `<name>_<lang>` suffixes. This minimises migration churn for existing tables — adding French is purely additive.

#### Read accessor

The store wraps records returned to the application in a thin accessor that resolves translatable fields against the active language:

```ts
// At read time, given record { title: "Hello", title_fr: "Bonjour" } and lang='fr':
record.title  // → "Bonjour"

// Fallback when target-lang value is null/empty:
// record { title: "Hello", title_fr: null }, lang='fr':
record.title  // → "Hello" (falls back to default lang)
```

The fallback behaviour is opt-out per-app via i18n config (`fallbackOnMissing: false` to surface gaps loudly).

#### Migration helper

`packages/store/migrations/add-language-column.ts` (new):

```ts
export async function addLanguageColumn(
  store: EntityStore,
  entity: string,
  lang: string,
): Promise<{ added: string[] }>;
```

For each `Translatable` field on `entity`, adds the `<field>_<lang>` column if missing. Idempotent. Apps can call this from their own migration scripts when adding a new supported language to an existing deployment.

## Implementation waves

The work splits into four sequenced waves. Waves 1–3 are framework changes; Wave 4 is per-app rollout.

### Wave 1 — Validate `i18next` in app (1-2 hours)

**Where:** `balcony-solar` only. **No Janus changes.**

1. `bun add i18next` at the workspace root.
2. Rewrite `src/lib/lang.ts` to wrap an `i18next` instance with `en` + `fr` resources (one key: `slogan`).
3. Smoke test: cookie still flips the slogan.

**Purpose:** Confirm `i18next` integrates cleanly with our Bun/Hono/Preact SSR stack before we commit framework code to it. Keeps the seam simple to reverse if we discover an incompatibility.

### Wave 2 — `@janus/i18n` package (2-3 days)

**Where:** Janus framework + balcony-solar consumer refactor.

1. Create `packages/i18n/` with `package.json`, `tsconfig.json`, `index.ts`, `__tests__/`.
2. Implement `createI18n`, `useT`, `useLang`, `LanguageSwitcher`, `checkParity`.
3. Implement `i18nMiddleware` in `packages/http/`. Hook into `ssr-renderer.ts` for `<html lang>` + Preact context.
4. Add tests: middleware resolution, fallback chain, parity script, switcher rendering.
5. Update `balcony-solar`:
   - Replace `src/lib/lang.ts` with `import from '@janus/i18n'`.
   - Replace ad-hoc `/lang/:value` route with `i18n.middleware()` mounted at app boot.
   - Move slogan strings to `lang/en.json` / `lang/fr.json`.
   - Remove the cookie-passing prop drilling (province-routes.ts, content-routes.ts) — middleware handles it.
6. Verify: `pluginsolarpower.ca/quebec` with `Cookie: lang=fr` still flips the slogan.

**Acceptance:** balcony-solar's behaviour is unchanged externally; internally the `lang/` files and `@janus/i18n` are the only points of contact for translation work.

### Wave 3 — `Translatable` field type (3-5 days)

**Where:** Janus framework — `vocabulary`, `core/compile.ts`, store adapters, migration helper.

1. Add `Translatable<T>` to `@janus/vocabulary`. Type-only change.
2. Extend `core/compile.ts` to recognise `TranslatableField` and forward language list to storage descriptors.
3. Update each store adapter:
   - **Memory** — synthesise parallel keys at create/update time; resolve at read time.
   - **SQLite** — generate `<field>_<lang>` columns at schema reconciliation; FTS5 indexes the active-language column.
   - **PostgreSQL** — same pattern, with `ALTER TABLE ADD COLUMN IF NOT EXISTS`.
4. Read-time accessor resolves `record.<field>` against `c.var.lang`. Implementation: a Proxy or a transformed-record wrapper depending on hot-path performance budget (benchmark first; SQLite reads are already JSON-stringify'd, so a simple field rewrite at the read-handler level is likely fastest).
5. Implement `addLanguageColumn` migration helper.
6. Add tests:
   - Schema reconciliation generates the right columns.
   - Read with `lang=fr` returns `_fr` value when present.
   - Fallback to default lang when `_fr` is null.
   - Update with `lang=fr` writes to `<field>_fr`, leaves `<field>` unchanged.
   - FTS search respects active language.

**Acceptance:** A `define()` schema with `Translatable(Str())` automatically provisions parallel columns, and reads/writes respect the active language with no app-level branching.

### Wave 4 — App rollout (per-app, ongoing)

**Where:** balcony-solar (and future apps as they're built).

For balcony-solar specifically:
1. Mark translatable fields on editorial entities: `news`, `article`, `faq`, `fact`, `regulation`, `milestone`, `provincial_campaign`. Run reconciliation; new columns appear.
2. Externalize hardcoded UI strings (nav, footer, buttons, errors, status labels) into `lang/en.json`. ~300-500 keys.
3. Translation pass — DeepL initial draft of `lang/fr.json` and `_fr` columns; native-speaker review before publish.
4. Petition + consent copy — explicit native review before publish (CASL/CRTC implication: a French consent record collected against translated copy that materially differs from the EN copy is **not the same consent** legally).
5. Smoke + audit — visit every page in FR mode; confirm no English leaks; verify `<html lang>` and `hreflang` are correct everywhere.

balcony-solar's own Phase 14 spec (`balcony-solar/.planning/phases/14-bilingual-site/14-PHASE.md`) already covers the app-side detail. This ADR is the prerequisite framework work.

## Migration path for existing Janus apps

Apps not currently using i18n take one of two stances when this lands:

1. **Stay monolingual.** No action required. Apps that don't call `createI18n()` get default behaviour: `lang='en'`, no middleware, no switcher, no `<html lang>` change. The `Translatable` wrapper is opt-in per field.
2. **Adopt bilingual.**
   - `bun add @janus/i18n` in the app workspace.
   - Create `lang/<code>.json` files.
   - Mount `i18n.middleware()` at app boot.
   - Mark translatable fields on relevant entities.
   - Run schema reconciliation; new columns appear.
   - Externalize hardcoded UI strings progressively (per-component, not big-bang).

The framework version of any consuming app already passes through migrations on deploy (per ADR-124-04c Schema Reconciliation), so the column additions land automatically. No manual SQL.

## Testing strategy

Janus already has `1154 tests` across packages (per CLAUDE.md). The i18n addition adds:

- **`@janus/i18n` unit tests** — middleware resolution order, parity script, switcher rendering, plural resolution.
- **`@janus/http` integration tests** — end-to-end: cookie → middleware → SSR renderer → emitted HTML has `<html lang>` + `hreflang`.
- **`@janus/store` adapter tests** — for each adapter (memory, SQLite, PostgreSQL): translatable field creates parallel columns; reads respect active lang; fallback works; FTS indexes active-language content.
- **`@janus/testing` proof entities** — extend the test harness with a `proof_translatable` entity demoing the full chain. Documentation-by-example.

## Open questions

1. **Path-prefix routing implementation cost.** Resolver order makes path-based opt-in (`/fr/<rest>` mirrors `/<rest>`). But generating those routes in the framework's route-derivation layer (`packages/http/route-table.ts`) needs care to avoid double-registration. **Decision needed at Wave 2 planning time.**
2. **FTS5 with multiple languages.** SQLite's FTS5 supports per-table language tokenisers but each FTS table is single-language. Options: (a) one FTS table per language; (b) one FTS table with the active-language content denormalised in. Pick at Wave 3 planning time. **Recommended:** (a), with `<entity>_fts_<lang>` table naming.
3. **Plural keys vs nested objects.** i18next supports both `key_one`/`key_other` plural suffixes and nested keys. The two interact — nested keys with plural variants. Need to lock the convention in Wave 2 so reviewers and translators see consistent input.
4. **Default-language fallback signalling.** When a record has `title: "Hello"` and no `title_fr`, an FR-mode reader sees "Hello." Should the renderer add a small "(English)" badge? Or fail silently? Or fail loudly (return 404 in strict mode)? **Recommended:** silent fallback by default (apps have varied tolerance for English-leakage); strict mode opt-in via i18n config.
5. **Per-supporter language preference.** A subscriber's `consent_record` may carry `language_at_grant`. Outbound advocacy emails should respect that. Not in scope for this ADR (no outbound email work here) but the i18n instance must expose `t(key, lang)` so app code can call it server-side without going through the request context. The API does — `i18n.t('subject.line', supporter.lang)` works.

## Out of scope

- **RTL languages.** Janus pages don't currently account for RTL CSS. Adding Arabic or Hebrew is a future ADR.
- **Currency / number formatting.** `Intl.NumberFormat` covers this without a Janus-level abstraction. Apps use it directly.
- **Date formatting.** Same — `Intl.DateTimeFormat`.
- **Translation management system (TMS).** We store translations as JSON files + DB columns. Integrating Crowdin/Lokalise/Phrase as the source of truth is an app-level concern (their CLI tools push/pull JSON; that's all we need to expose).
- **Build-time string extraction.** Manual key authoring in Wave 2; revisit only if the team grows enough that drift becomes the bottleneck.
- **Translation-pending workflow.** Records with `_fr: null` simply fall back. A "translation queue" UI for editors is an app-level concern, not framework.
- **Admin UI translation.** Admin chrome for any consuming app stays in English. Translating admin tooling is per-app and not framework-blessed.

## Success criteria

For Janus framework (Waves 1–3):

1. A new app can become bilingual with: `bun add @janus/i18n`, two JSON files, three lines of bootstrap.
2. Marking an entity field as translatable is one wrapper: `Translatable(Str())`. No further app code change required for storage or read.
3. `<html lang>` + `hreflang` alternates emit correctly on every SSR-rendered page automatically.
4. The CI parity script catches missing translation keys before merge.
5. Existing monolingual Janus apps see zero behavioural change.

For balcony-solar (Wave 4 — tracked in app's Phase 14 doc):

6. Every public route on `pluginsolarpower.ca` has bilingual content.
7. Petition + consent flows submit valid `consent_record` with `language_at_grant` — meaning verifiable against visible copy.
8. A francophone advocate can use the site end-to-end without ever seeing English chrome.

## References

- ADR-124-08 — HTTP Surface and Bootstrap (the SSR renderer this extends).
- ADR-124-10 — Presentation and Binding (the Preact context plumbing this consumes).
- ADR-124-04 — Store Adapters and CRUD Handlers (the storage layer the column provisioning extends).
- ADR-124-04c — Schema Reconciliation (how the new columns land for deployed apps).
- balcony-solar `.planning/phases/14-bilingual-site/14-PHASE.md` — first consumer of this ADR; depends on Waves 1–3 landing.
- [`i18next` documentation](https://www.i18next.com/) — the underlying library we wrap.
- [CLDR Plural Rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html) — French vs English plural grammar.

---

*Draft for review. The Wave 1 prototype already shipped in balcony-solar (commit `9c75c70`); use that as the reference seam when implementing Waves 2 and 3.*
