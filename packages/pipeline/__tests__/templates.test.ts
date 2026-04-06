/**
 * Integration tests for ADR 10b: Templates.
 *
 * Exercises: Template() type, template framework entity, LiquidJS rendering,
 * semantic type filters, schema-derived rendering, variable validation.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  compile,
  clearRegistry,
  SYSTEM,
} from '@janus/core';
import type { CompileResult, EntityStore } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
  renderTemplate,
  renderFromSchema,
  validateTemplateVariables,
} from '..';
import type { DispatchRuntime } from '..';
import { Str, Int, IntCents, Bool, DateTime, Template, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Template() semantic type ────────────────────────────────────

describe('Template() semantic type', () => {
  test('Template() produces correct field descriptor', () => {
    const field = Template();
    expect(field.kind).toBe('template');
    expect(field.hints).toBeDefined();
  });

  test('Template() with format hint', () => {
    const field = Template({ format: 'html' });
    expect(field.hints.format).toBe('html');
  });

  test('entity with Template() field compiles', () => {
    registerHandlers();

    const notification = define('notification', {
      schema: {
        name: Str({ required: true }),
        body: Template({ format: 'html' }),
      },
      storage: Persistent(),
    });

    const registry = compile([
      notification, participate(notification, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    expect(registry.entity('notification')).toBeDefined();
  });
});

// ── template framework entity ───────────────────────────────────

describe('template framework entity', () => {
  test('template entity is included in framework entities', () => {
    registerHandlers();
    const registry = compile([...frameworkEntities, ...frameworkParticipations]);
    expect(registry.entity('template')).toBeDefined();
    expect(registry.entity('template')!.origin).toBe('framework');
  });

  test('template CRUD works via dispatch', async () => {
    registerHandlers();

    const registry = compile([...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // Create a template
    const createResp = await runtime.dispatch('system', 'template', 'create', {
      name: 'note-created-email',
      format: 'html',
      entity: 'note',
      subject: 'New note: {{ title }}',
      body: '<h1>{{ title }}</h1><p>{{ body }}</p>',
    }, SYSTEM);
    expect(createResp.ok).toBe(true);

    // Read it back
    const id = (createResp.data as { id: string }).id;
    const readResp = await runtime.dispatch('system', 'template', 'read', { id }, SYSTEM);
    expect(readResp.ok).toBe(true);
    expect((readResp.data as Record<string, unknown>).name).toBe('note-created-email');
    expect((readResp.data as Record<string, unknown>).format).toBe('html');
  });
});

// ── LiquidJS rendering ──────────────────────────────────────────

describe('renderTemplate()', () => {
  test('renders basic Liquid template', async () => {
    const result = await renderTemplate({
      template: 'Hello, {{ name }}!',
      data: { name: 'Alice' },
    });
    expect(result).toBe('Hello, Alice!');
  });

  test('renders with context merged into data', async () => {
    const result = await renderTemplate({
      template: '{{ greeting }}, {{ name }}!',
      data: { name: 'Bob' },
      context: { greeting: 'Hi' },
    });
    expect(result).toBe('Hi, Bob!');
  });

  test('renders with layout', async () => {
    const result = await renderTemplate({
      template: 'Inner content here',
      data: {},
      layout: '<header>Header</header>{{ content }}<footer>Footer</footer>',
    });
    expect(result).toBe('<header>Header</header>Inner content here<footer>Footer</footer>');
  });

  test('unknown variables render as empty', async () => {
    const result = await renderTemplate({
      template: 'Hello {{ missing }}!',
      data: {},
    });
    expect(result).toBe('Hello !');
  });
});

// ── Semantic type filters ───────────────────────────────────────

describe('semantic type filters', () => {
  test('cents filter formats money', async () => {
    const result = await renderTemplate({
      template: '{{ amount | cents }}',
      data: { amount: 2500 },
    });
    expect(result).toBe('$25.00');
  });

  test('bps filter formats percentage', async () => {
    const result = await renderTemplate({
      template: '{{ rate | bps }}',
      data: { rate: 1500 },
    });
    expect(result).toBe('15.00%');
  });

  test('yesno filter formats boolean', async () => {
    const yes = await renderTemplate({ template: '{{ v | yesno }}', data: { v: true } });
    expect(yes).toBe('Yes');
    const no = await renderTemplate({ template: '{{ v | yesno }}', data: { v: false } });
    expect(no).toBe('No');
  });

  test('number filter formats with locale', async () => {
    const result = await renderTemplate({
      template: '{{ n | number }}',
      data: { n: 1234567 },
    });
    expect(result).toMatch(/1.*234.*567/); // Locale-dependent separator
  });

  test('token filter masks middle', async () => {
    const result = await renderTemplate({
      template: '{{ key | token }}',
      data: { key: 'sk-abc123def456' },
    });
    expect(result).toBe('sk-a...f456');
  });

  test('duration filter formats milliseconds', async () => {
    const result = await renderTemplate({
      template: '{{ d | duration }}',
      data: { d: 3661000 },
    });
    expect(result).toBe('1h 1m');
  });
});

// ── Schema-derived rendering ────────────────────────────────────

describe('renderFromSchema()', () => {
  test('renders entity record from schema (text format)', () => {
    registerHandlers();

    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        amount: IntCents(),
        active: Bool(),
      },
      storage: Persistent(),
    });
    const registry = compile([note, participate(note, {})]);
    const entity = registry.entity('note')!;

    const record = {
      id: '123',
      _version: 1,
      createdAt: '2026-04-04T00:00:00Z',
      createdBy: 'system',
      updatedAt: '2026-04-04T00:00:00Z',
      updatedBy: 'system',
      title: 'My Note',
      amount: 2500,
      active: true,
    };

    const result = renderFromSchema(entity, record, 'text');
    expect(result.format).toBe('text');
    expect(result.body).toContain('title: My Note');
    expect(result.body).toContain('amount: $25.00');
    expect(result.body).toContain('active: Yes');
  });

  test('renders markdown format', () => {
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const registry = compile([note, participate(note, {})]);
    const entity = registry.entity('note')!;

    const record = {
      id: '1', _version: 1, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
      title: 'Test',
    };

    const result = renderFromSchema(entity, record, 'markdown');
    expect(result.body).toContain('**title:** Test');
  });
});

// ── Template variable validation ────────────────────────────────

describe('validateTemplateVariables()', () => {
  test('returns empty for all valid variables', () => {
    const warnings = validateTemplateVariables(
      '{{ title }} by {{ author }}',
      ['title', 'author', 'body'],
    );
    expect(warnings).toEqual([]);
  });

  test('detects unknown variables', () => {
    const warnings = validateTemplateVariables(
      '{{ title }} {{ unknown_field }} {{ missing }}',
      ['title', 'body'],
    );
    expect(warnings).toContain('unknown_field');
    expect(warnings).toContain('missing');
    expect(warnings).not.toContain('title');
  });

  test('allows framework fields (id, createdAt, etc.)', () => {
    const warnings = validateTemplateVariables(
      '{{ id }} created {{ createdAt }}',
      ['title'],
    );
    expect(warnings).toEqual([]);
  });
});
