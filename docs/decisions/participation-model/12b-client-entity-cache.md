# 124-12b: Rendering Infrastructure

**Status:** Draft
**Date:** 2026-04-03
**Depends on:** [10](10-presentation-and-binding.md) (Binding Model), [12a](12a-connection-protocol-and-sync.md) (Connection Entity)
**Package:** `@janus-next/client`

## Scope

This sub-ADR specifies:
- Preact as the rendering layer — `.tsx` components, `@preact/signals` for reactivity
- Hono-served SSR — `preact-render-to-string`, hydration, document template
- Binding registry — the agent-visible inventory of active binding contexts on a page
- SSE → signal bridge — server push events update binding context signals
- Client-side navigation — tear down / rebuild binding contexts, `/_page` API
- Dispatch helper — `dispatchEntity()` for client-side mutations
- Field component registry — mapping rendering hints to component implementations
- CSS — CSS Modules for scoping, custom properties for theming, Tailwind optional
- Vite configuration for client bundling

This sub-ADR does NOT cover:
- Binding model (BindingRecord, BindingContext, FieldState, bind(), agent interaction) — see [10](10-presentation-and-binding.md)
- Connection entity, channel lifecycle, sync protocol — see [12a](12a-connection-protocol-and-sync.md)
- Server-side dispatch pipeline — see [06](06-dispatch-runtime.md)

## Context

Sub-ADR [10](10-presentation-and-binding.md) defines the binding model — `bind()`, `BindingRecord`, `BindingContext`, `FieldState` with committed/current/dirty tracking. These are framework-independent data structures and contracts.

This sub-ADR implements those contracts using Preact and `@preact/signals`. Janus already owns the HTTP surface (Hono), routing (dispatch index), and data loading (pipeline). Preact is the rendering layer — a thin projection of the binding state onto DOM. Janus is the framework.

## Decision

### Why Preact

Components are `.tsx` TypeScript functions — directly importable into `bind()` as values. `@preact/signals` provides reactive primitives (`.value` read/write, `effect()` observation) that work in any TypeScript file without a special compiler. The agent harness, the component tree, and the dispatch layer all share the same signal instances. No bridge between reactive systems.

### Package structure

```
@janus-next/client
  core/           createBindingContext(), FieldState, dispatch helper (framework-agnostic)
  render/         Hono SSR integration, document template, hydration entry
  components/     Framework-provided field renderers, EntityView, EntityFilter
```

### Hono-served SSR

The HTTP surface serves pages alongside API routes. Page rendering is a framework concern.

#### Request → HTML

```ts
app.get('/*', async (c) => {
  const identity = resolveIdentity(c);
  const route = registry.resolveRoute(c.req.path);
  if (!route) return c.notFound();

  // Load data through the pipeline (identity-scoped)
  const record = await pipeline.read(route.entity, { id: route.id }, identity);
  const binding = registry.bindings.byEntityAndView(route.entity, route.view);
  const schema = registry.schemaFor(route.entity);

  // Load additional entities for this page
  const pageData = await loadPageDependencies(route, identity);

  // Create binding contexts (signals populated from entity data)
  const contexts = buildPageContexts(route, binding, record, schema, pageData);
  const cursor = await pipeline.currentCursor();

  // Render to HTML
  const Component = binding.component;
  const appHtml = renderToString(
    <PageShell contexts={contexts}>
      <Component fields={contexts[0].fields} config={binding.config} />
    </PageShell>
  );

  return c.html(renderDocument(appHtml, contexts, cursor));
});
```

#### HTML document

```ts
function renderDocument(appHtml: string, contexts: BindingContext[], cursor: string): string {
  const initData = serializeContexts(contexts);
  return `<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="/assets/app.css" /></head>
<body>
  <div id="app">${appHtml}</div>
  <script type="module">
    window.__JANUS__ = ${JSON.stringify({ contexts: initData, cursor })};
    import('/assets/client.js');
  </script>
</body>
</html>`;
}
```

`serializeContexts` extracts plain values from signals (committed values, field metadata). Signals are recreated on the client during hydration.

#### Client hydration

```ts
// client/entry.ts — browser entry point, bundled by Vite
import { hydrate } from 'preact';
import { createEntityConnection } from '@janus-next/client';

const init = window.__JANUS__;

// Recreate binding contexts as live signals
const contexts = init.contexts.map(ctx =>
  createBindingContext(ctx.entity, ctx.id, ctx.view, ctx.binding, ctx.values, ctx.schema)
);

// Register with binding registry (agent-visible)
bindingRegistry.setActiveContexts(contexts);

// Hydrate — Preact attaches event listeners to existing DOM
hydrate(
  <PageShell contexts={contexts}>...</PageShell>,
  document.getElementById('app')
);

// Establish SSE connection with cursor from SSR
createEntityConnection({
  baseUrl: '/api',
  protocol: 'sse',
  cursor: init.cursor,
  subscribe: [...new Set(contexts.map(c => c.entity))],
  auth: () => getAuthToken(),
  onEntityChanged(entity, id, record) {
    updateBindingContexts(contexts, entity, id, record);
  },
  onEntityDeleted(entity, id) {
    removeFromBindingContexts(contexts, entity, id);
  },
});
```

### SSE → signal bridge

When the server pushes an entity change, the bridge updates committed signal values on matching binding contexts:

```ts
function updateBindingContexts(
  contexts: BindingContext[],
  entity: string,
  id: string,
  record: Record<string, unknown>,
) {
  for (const ctx of contexts) {
    if (ctx.entity !== entity) continue;

    const updateFields = (fields: Record<string, FieldState>) => {
      for (const [field, value] of Object.entries(record)) {
        if (!fields[field]) continue;
        fields[field].committed.value = value;
        if (!fields[field].dirty.value) {
          fields[field].current.value = value;
        }
      }
    };

    // Detail view: update if id matches
    if (ctx.id === id) updateFields(ctx.fields);

    // List view: update matching record
    if (ctx.records) {
      const rec = ctx.records.find(r => r.id === id);
      if (rec) updateFields(rec.fields);
    }
  }
}
```

Dirty fields are preserved — `committed` updates but `current` does not, so the user's unsaved edits are not overwritten. See [10](10-presentation-and-binding.md) for the full field state lifecycle.

### Binding registry

The agent-visible inventory of active binding contexts. Plain TypeScript — no framework dependency:

```ts
interface BindingRegistry {
  getActiveContexts(): readonly BindingContext[];
  setActiveContexts(contexts: readonly BindingContext[]): void;
  clearActiveContexts(): void;
  onContextsChanged(fn: () => void): () => void;
}
```

Initialized in the client entry, updated on navigation. The agent harness reads it to understand the page — see [10](10-presentation-and-binding.md) for agent interaction patterns.

### Client-side navigation

```ts
async function navigate(url: string) {
  // Fetch page data from framework-seeded API endpoint
  const response = await fetch(`/api/_page?url=${encodeURIComponent(url)}`);
  const { route, contexts: contextData, cursor } = await response.json();

  // Tear down current contexts
  bindingRegistry.clearActiveContexts();

  // Build new binding contexts from fresh data
  const newContexts = contextData.map(ctx =>
    createBindingContext(ctx.entity, ctx.id, ctx.view, ctx.binding, ctx.values, ctx.schema)
  );
  bindingRegistry.setActiveContexts(newContexts);

  // Re-render
  render(<PageShell contexts={newContexts}>...</PageShell>, document.getElementById('app'));

  // Update SSE subscriptions for new entities
  connection.updateSubscriptions([...new Set(newContexts.map(c => c.entity))]);

  // Update session with all active contexts
  connection.navigate(url, newContexts.map(c => ({
    entity: c.entity, id: c.id, view: c.view,
    fields: Object.keys(c.fields),
  })));
}
```

The `/_page` API endpoint is framework-seeded on the HTTP surface. It resolves the URL to entity routes, loads data through the pipeline with the request identity, and returns serialized binding context data.

### Dispatch helper

For client-side mutations (inline editing, drag-and-drop, agent-triggered saves):

```ts
interface DispatchEntityConfig {
  readonly baseUrl: string;
  readonly auth: () => Promise<string>;
}

function createDispatchEntity(config: DispatchEntityConfig): DispatchEntityFn;

type DispatchEntityFn = (
  entity: string,
  operation: string,
  input: Record<string, unknown>,
) => Promise<DispatchResult>;

interface DispatchResult {
  readonly ok: boolean;
  readonly data?: EntityRecord;
  readonly error?: { code: string; message: string };
}
```

Save flow for a binding context:

```ts
async function saveContext(ctx: BindingContext, dispatch: DispatchEntityFn) {
  const patch: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(ctx.fields)) {
    if (field.dirty.value && field.meta.agent === 'read-write') {
      patch[name] = field.current.value;
    }
  }
  if (Object.keys(patch).length === 0) return;

  const result = await dispatch(ctx.entity, 'update', { id: ctx.id, ...patch });
  if (result.ok && result.data) {
    for (const [name, value] of Object.entries(result.data)) {
      if (ctx.fields[name]) {
        ctx.fields[name].committed.value = value;
      }
    }
  }
  return result;
}
```

After save, committed matches current, dirty becomes false. The originating connection does not receive its own push event (originator-skip in [12a](12a-connection-protocol-and-sync.md)).

### Field component registry

Maps rendering hints (from `FieldBindingConfig.component`) to Preact component implementations:

```ts
const fieldRenderers: Record<string, ComponentType<{ field: FieldState }>> = {
  'heading': EditableHeading,
  'richtext': RichTextEditor,
  'badge': StatusBadge,
  'date-picker': DatePicker,
  'user-link': UserLink,
};
```

Framework-provided field components read and write signals directly:

```tsx
function EditableHeading({ field }: { field: FieldState<string> }) {
  return (
    <input
      value={field.current}
      onInput={(e) => { field.current.value = e.currentTarget.value; }}
      className={field.dirty.value ? 'edited' : ''}
    />
  );
}

function StatusBadge({ field }: { field: FieldState<string> }) {
  return <span className={`badge badge-${field.current}`}>{field.current}</span>;
}
```

Passing a signal directly into JSX (`{field.current}` not `{field.current.value}`) lets Preact update the specific DOM node without re-rendering the component.

Consumers can register custom field renderers for domain-specific types.

### CSS

**CSS Modules** for component scoping — `.module.css` files, zero-config with Vite:

```tsx
import styles from './NoteDetail.module.css';

function NoteDetail({ fields, config }) {
  return <div className={styles.card}>...</div>;
}
```

**CSS custom properties** for theming — same pattern as v1:

```css
:root {
  --accent: #3b82f6;
  --density: 1;
  --font-family: system-ui;
}
```

**Tailwind** optional — works with Preact identically to any other framework.

### Vite configuration

```ts
import preact from '@preact/preset-vite';

export default {
  plugins: [preact()],
  build: {
    rollupOptions: {
      input: { client: 'client/entry.tsx' },
    },
  },
};
```

Vite handles JSX compilation, CSS Modules, code splitting via dynamic `import()`, and production bundling.

## Testing gate

When 124-12b is implemented:

- `renderToString()` renders Preact component tree to HTML from binding context signals
- `hydrate()` attaches event listeners to server-rendered DOM
- Client entry recreates live signals from serialized init data
- SSE `entity:changed` updates `committed` on matching binding context
- SSE update to non-dirty field updates both `committed` and `current`
- SSE update to dirty field updates only `committed` (preserves user edits)
- `bindingRegistry.getActiveContexts()` returns all active contexts
- `bindingRegistry.setActiveContexts()` updates on navigation
- `bindingRegistry.clearActiveContexts()` tears down on navigation
- `/_page` API returns serialized context data for client-side navigation
- `createDispatchEntity()` returns dispatch function that POSTs to entity API
- `saveContext()` collects dirty read-write fields and dispatches update
- After save, committed matches server response, dirty is false
- `fieldRenderers` registry maps component hints to Preact components
- Field components read/write signals directly (`.current.value`)
- CSS Modules scope styles per component
- Vite builds client bundle with code splitting
- `renderDocument()` embeds serialized contexts and cursor in HTML
- Cursor from SSR seeds the SSE connection for gap-free handoff
