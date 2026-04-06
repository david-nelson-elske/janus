# 124-10b: Template Column Type & Rendering

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [00](00-vocabulary.md) (Vocabulary), [01](01-core-records-and-define.md) (Core Records), [04](04-store-adapters-and-crud.md) (Store Adapters), [10](10-presentation-and-binding.md) (Presentation)
**Amends:** [00](00-vocabulary.md) (Vocabulary — new semantic type), [10](10-presentation-and-binding.md) (BindingRecord.template becomes Reference)

## Scope

This sub-ADR specifies:
- `Template()` — semantic column type for file-backed template source (third in the `Asset()` / `Append()` family)
- `template` framework entity — name, format, entity binding, source file pointers
- Template rendering via LiquidJS with semantic type filters (carried forward from V1)
- How templates integrate with subscriptions (email/notification), agent prompts, and bindings
- Compile-time validation of template variables against bound entity schemas

This sub-ADR does NOT cover:
- Actual Svelte/voice/CLI rendering implementations
- Subscription adapter implementations ([07](07-subscriptions-broker-scheduler.md))
- Agent surface internals ([09](09-agent-surface-and-session.md))
- Dynamic UI composition / slot model (deferred)

## Problem

V1 had a full template system (`@janus/template`) built on LiquidJS with custom semantic type filters, layout inheritance, and compile-time schema validation. Templates powered email notifications, agent prompts, and admin CLI entity rendering.

ADR-124 needs the same capability, but the V1 system was a global registry with `defineTemplate()` — not an entity. In the participation model, templates should be entities with records in the graph, discoverable by agents, and composed through the same file-backed column pattern as assets and append payloads.

## Decision

### Template() column type

A new semantic type in the vocabulary, completing the file-backed column family:

| Column type | Points to | On write | On read |
|-------------|-----------|----------|---------|
| `Asset()` ([08b](08b-assets-and-media.md)) | Binary file (image, PDF) | Stream to backend, store pointer | Resolve to metadata + URL |
| `Append()` ([04b](04b-append-storage-and-execution-log.md)) | JSON in JSONL file | Serialize + append, store pointer | Resolve pointer to parsed JSON |
| `Template()` | Template source file | Store file path | Resolve to source string |

```ts
function Template(config?: {
  format?: 'html' | 'markdown' | 'text';
}): SemanticType
```

Default: `Template()` → format inferred from file extension, or `'text'`.

The database column stores a file path. On read, the framework resolves the path to the template source string. Rendering is a separate operation — the caller invokes render with a data context.

### template entity

Framework-provided entity for template records:

```ts
define('template', {
  schema: {
    name: Str({ required: true }),
    format: Str({ required: true }),        // 'html' | 'markdown' | 'text'
    entity: Str(),                           // optional: entity name for compile-time validation
    subject: Str(),                          // subject line with template variables (emails)
    body: Template(),                        // file pointer → template source
    layout: Reference('template'),           // layout inheritance chain
    context: Json(),                         // static context merged into render data
  },
  storage: Persistent(),
  origin: 'framework',
});
```

| Field | Purpose |
|-------|---------|
| `name` | Lookup key — `'note-created-email'`, `'agent-entity-prompt'` |
| `format` | Output format: html (email), markdown (agent), text (CLI/voice) |
| `entity` | Binds template variables to an entity schema for compile-time validation |
| `subject` | Inline template string for email subject lines (short, no file needed) |
| `body` | `Template()` column — file pointer to the template source |
| `layout` | Reference to a parent template for layout inheritance |
| `context` | Static key-value pairs merged into every render invocation |

### Compile-time validation

When `entity` is set, the compile step validates template variables against that entity's schema:

```
compile(templates, registry):
  for each template where template.entity is set:
    schema = registry.graphNodes[template.entity].schema
    variables = extractVariables(template.body)  // {{ title }}, {{ amount | cents }}

    for each variable:
      if variable.name not in schema:
        warning: "{{ variable.name }} not found in {{ template.entity }} schema"
      if variable.filter and filterMismatch(schema[variable.name], variable.filter):
        warning: "{{ variable.name }} is {{ schemaType }}, consider {{ recommendedFilter }}"
```

This is the same validation V1 performed — template variables checked against entity fields, with filter recommendations based on semantic type. Warnings, not errors — templates may reference computed context beyond the entity schema.

### Semantic type filters

Filters map 1:1 with vocabulary types. Carried forward from V1's `@janus/template`:

| Vocabulary type | Filter | Example |
|----------------|--------|---------|
| `IntCents` | `cents` | `2500` → `"$25.00"` |
| `IntBps` | `bps` | `1500` → `"15.00%"` |
| `Duration` | `duration` | `3600000` → `"1 hour"` |
| `DateTime` | `datetime` | ISO/epoch → formatted date (supports 'short', 'long', 'iso', 'relative') |
| `Bool` | `yesno` | `true` → `"Yes"` |
| `Int` / `Decimal` | `number` | `1234567` → `"1,234,567"` |
| `Asset` | `asset_url` | `"abc123"` → `"/assets/abc123"` |
| `Token` | `token` | `"sk-abc...xyz"` → `"sk-abc...xyz"` (masked middle) |

Filters are registered on the LiquidJS engine at bootstrap. Consumer code can register additional filters.

### Rendering

Two-tier rendering, carried forward from V1:

**Tier 1 — Schema-derived (no template needed):**
When no template is specified, the framework auto-generates output by walking the entity schema, applying semantic type formatters to each field. Produces subject + body for notifications, structured output for agent prompts.

**Tier 2 — Named template:**
Resolve template record → load body from file → merge entity data + static context + caller context → render with LiquidJS → return subject + body.

```ts
interface RenderContext {
  entityName: string;
  data: EntityRecord;
  event?: string;            // 'created', 'updated', etc.
  extra?: Record<string, unknown>;  // caller-provided context
}

interface RenderResult {
  subject: string;
  body: string;
  format: 'html' | 'markdown' | 'text';
}
```

**Layout inheritance:**
Templates can declare a `layout` reference to a parent template. The parent template contains `{% block content %}{% endblock %}` — the child's rendered body is injected there. Layout chains are resolved recursively (a layout can have its own layout).

### Integration with subscriptions

Subscription adapters that produce output (email, notification, webhook) can reference a template:

```ts
subscribe('note', [
  { on: Created, handler: 'notify-sender',
    config: { channel: 'email', to: 'owner', template: 'note-created-email' },
    tracked: true },
]);
```

The adapter resolves the template by name, renders with the entity record that triggered the event, and uses the rendered output. If no template specified, falls back to tier 1 (schema-derived) rendering.

### Integration with agent

Agent prompt templates use markdown format. The agent surface reads the template, renders with entity data + session context, and includes the result in the prompt:

```ts
// Template record
{ name: 'agent-entity-prompt', format: 'markdown', entity: 'note',
  body: Template() }  // points to: templates/agent-entity-prompt.md

// Template file content:
// ## {{ entityName }}: {{ title }}
// **Status:** {{ status }}
// **Created:** {{ createdAt | datetime: 'relative' }}
//
// {{ body | markdown }}
```

The agent can discover available templates through `read('template', { where: { entity: 'note' } })` — templates are entities in the graph, browseable like any other.

### Integration with binding (10)

`BindingRecord.template` from [10](10-presentation-and-binding.md) becomes a Reference to the `template` entity:

```ts
interface BindingRecord {
  // ... existing fields ...
  readonly template?: string;  // Reference → template.name
}
```

Voice and text modalities use the template for rendering. Visual modalities (Svelte) typically use `component` instead, but may use templates for email-style rich content.

### What carries forward from V1

| V1 (`@janus/template`) | ADR-124 (`template` entity + `Template()` type) |
|------------------------|------------------------------------------------|
| `defineTemplate(name, config)` | `create('template', { name, ... })` — template is an entity |
| Global template registry | Entity records in the graph — queryable, agent-discoverable |
| `TemplateConfig.entity` | `template.entity` field — same compile-time validation |
| `TemplateConfig.body` (inline string) | `template.body` as `Template()` column → file pointer |
| `TemplateConfig.layout` (string name) | `template.layout` as `Reference('template')` |
| LiquidJS engine + custom filters | Same engine, same filters, mapped to vocabulary types |
| `renderNotify()` / `renderCompiled()` | Tier 1 (schema-derived) / Tier 2 (named template) — same split |
| `renderFromSchema()` auto-generation | Tier 1 — walks schema, applies formatters |
| Layout inheritance via blocks | Same: `{% block content %}...{% endblock %}` |

### Updated infrastructure entity count

| Entity | Storage | New? |
|--------|---------|------|
| `template` | Persistent | **Yes** |

Total infrastructure entities: **14** (was 13 after 04b).

## Open questions

### Template variable binding beyond entity schema

Some templates need context beyond the bound entity — the current user, the event type, computed values, or data from related entities. V1 solved this with the `context` field (static overrides) and caller-provided `extra` context. Is this sufficient, or should templates declare their full expected context shape (entity fields + additional variables)?

### Agent-generated templates

Should agents be able to create or modify template records? This would let an agent customize email layouts or prompt structures. The `template` entity participates in the standard pipeline, so policy and audit apply. But agent-authored templates need review workflows — a generated email template going live without human review is risky.

## Testing gate

When 124-10b is implemented:

- `Template()` constructor returns a valid semantic type
- `template` entity can be created with name, format, body (file pointer)
- Template file is stored on disk, pointer stored in database column
- Read of template resolves `body` column to template source string
- Compile validates template variables against bound entity schema
- Missing field produces warning, not error
- Filter mismatch produces recommendation warning
- Named template renders correctly with entity data context
- Schema-derived rendering (no template) produces formatted output
- Semantic type filters format correctly (cents, datetime, bps, etc.)
- Layout inheritance renders child content in parent layout block
- Subscription adapter resolves template by name and renders before sending
- Agent can read templates: `read('template', { where: { entity: 'note' } })`
- `BindingRecord.template` references a template entity record
- Static `context` on template record merges into render data
