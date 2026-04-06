/**
 * Unit tests for the template engine — LiquidJS rendering with
 * semantic type filters (ADR 10b).
 *
 * Complements the integration tests in templates.test.ts.
 * Focuses on: filter edge cases, renderFromSchema formats,
 * and validateTemplateVariables deduplication/nested access.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  renderTemplate,
  renderFromSchema,
  validateTemplateVariables,
  registerHandlers,
} from '..';
import { define, participate, compile, clearRegistry } from '@janus/core';
import { Str, Int, IntCents, IntBps, Bool, DateTime, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── renderTemplate ─────────────────────────────────────────────

describe('renderTemplate()', () => {
  test('simple variable substitution', async () => {
    const result = await renderTemplate({
      template: 'Hello {{ name }}',
      data: { name: 'World' },
    });
    expect(result).toBe('Hello World');
  });

  test('cents filter: 1234 → "$12.34"', async () => {
    const result = await renderTemplate({
      template: '{{ amount | cents }}',
      data: { amount: 1234 },
    });
    expect(result).toBe('$12.34');
  });

  test('bps filter: 1234 → "12.34%"', async () => {
    const result = await renderTemplate({
      template: '{{ rate | bps }}',
      data: { rate: 1234 },
    });
    expect(result).toBe('12.34%');
  });

  test('duration filter: milliseconds → human readable', async () => {
    // < 1s
    expect(await renderTemplate({ template: '{{ d | duration }}', data: { d: 500 } })).toBe('500ms');
    // seconds
    expect(await renderTemplate({ template: '{{ d | duration }}', data: { d: 5000 } })).toBe('5s');
    // minutes + seconds
    expect(await renderTemplate({ template: '{{ d | duration }}', data: { d: 125000 } })).toBe('2m 5s');
    // hours + minutes
    expect(await renderTemplate({ template: '{{ d | duration }}', data: { d: 3720000 } })).toBe('1h 2m');
  });

  test('yesno filter: truthy → "Yes", falsy → "No"', async () => {
    expect(await renderTemplate({ template: '{{ v | yesno }}', data: { v: true } })).toBe('Yes');
    expect(await renderTemplate({ template: '{{ v | yesno }}', data: { v: false } })).toBe('No');
    expect(await renderTemplate({ template: '{{ v | yesno }}', data: { v: 1 } })).toBe('Yes');
    expect(await renderTemplate({ template: '{{ v | yesno }}', data: { v: 0 } })).toBe('No');
  });

  test('token filter: long token → masked (first 4 + last 4)', async () => {
    const result = await renderTemplate({
      template: '{{ t | token }}',
      data: { t: 'sk-abcdefghij1234' },
    });
    expect(result).toBe('sk-a...1234');
  });

  test('token filter: short tokens pass through', async () => {
    const result = await renderTemplate({
      template: '{{ t | token }}',
      data: { t: 'abc123' },
    });
    expect(result).toBe('abc123');
  });

  test('number filter: localized formatting', async () => {
    const result = await renderTemplate({
      template: '{{ n | number }}',
      data: { n: 1000000 },
    });
    // Locale-dependent, but should contain digit grouping
    expect(result).toMatch(/1.*000.*000/);
  });

  test('layout rendering: body injected into {{ content }}', async () => {
    const result = await renderTemplate({
      template: 'Inner {{ name }}',
      data: { name: 'content' },
      layout: '<html>{{ content }}</html>',
    });
    expect(result).toBe('<html>Inner content</html>');
  });

  test('context merging: context + data combined', async () => {
    const result = await renderTemplate({
      template: '{{ org }} - {{ title }}',
      data: { title: 'Note' },
      context: { org: 'PCA' },
    });
    expect(result).toBe('PCA - Note');
  });
});

// ── renderFromSchema ───────────────────────────────────────────

describe('renderFromSchema()', () => {
  function setup() {
    registerHandlers();
    const invoice = define('invoice', {
      schema: {
        title: Str({ required: true }),
        amount: IntCents(),
        rate: IntBps(),
        active: Bool(),
        count: Int(),
      },
      storage: Persistent(),
    });
    const registry = compile([invoice, participate(invoice, {})]);
    return registry.entity('invoice')!;
  }

  const record = {
    id: 'inv-1',
    _version: 1,
    createdAt: '2026-04-04T00:00:00Z',
    createdBy: 'system',
    updatedAt: '2026-04-04T00:00:00Z',
    updatedBy: 'system',
    title: 'Invoice A',
    amount: 5000,
    rate: 1500,
    active: true,
    count: 42,
  };

  test('text format: "field: value" lines', () => {
    const entity = setup();
    const result = renderFromSchema(entity, record, 'text');
    expect(result.format).toBe('text');
    expect(result.body).toContain('title: Invoice A');
    expect(result.body).toContain('amount: $50.00');
    expect(result.body).toContain('rate: 15.00%');
    expect(result.body).toContain('active: Yes');
    expect(result.body).toContain('count: 42');
  });

  test('markdown format: "**field:** value" lines', () => {
    const entity = setup();
    const result = renderFromSchema(entity, record, 'markdown');
    expect(result.format).toBe('markdown');
    expect(result.body).toContain('**title:** Invoice A');
    expect(result.body).toContain('**amount:** $50.00');
    expect(result.body).toContain('**active:** Yes');
  });

  test('html format: <dt>field</dt><dd>value</dd> wrapped in <dl>', () => {
    const entity = setup();
    const result = renderFromSchema(entity, record, 'html');
    expect(result.format).toBe('html');
    expect(result.body).toMatch(/^<dl>.*<\/dl>$/);
    expect(result.body).toContain('<dt>title</dt><dd>Invoice A</dd>');
    expect(result.body).toContain('<dt>amount</dt><dd>$50.00</dd>');
    expect(result.body).toContain('<dt>active</dt><dd>Yes</dd>');
  });

  test('subject is "entityName: id"', () => {
    const entity = setup();
    const result = renderFromSchema(entity, record);
    expect(result.subject).toBe('invoice: inv-1');
  });

  test('null/undefined values skipped', () => {
    const entity = setup();
    const sparse = {
      id: 'inv-2', _version: 1, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
      title: 'Sparse',
      amount: null,
      rate: undefined,
      active: null,
      count: undefined,
    };
    const result = renderFromSchema(entity, sparse as any, 'text');
    expect(result.body).toContain('title: Sparse');
    expect(result.body).not.toContain('amount');
    expect(result.body).not.toContain('rate');
    expect(result.body).not.toContain('active');
    expect(result.body).not.toContain('count');
  });
});

// ── validateTemplateVariables ──────────────────────────────────

describe('validateTemplateVariables()', () => {
  test('known fields return empty array', () => {
    const unknowns = validateTemplateVariables(
      '{{ title }} {{ body }}',
      ['title', 'body'],
    );
    expect(unknowns).toEqual([]);
  });

  test('unknown fields returned in array', () => {
    const unknowns = validateTemplateVariables(
      '{{ title }} {{ bad_field }}',
      ['title', 'body'],
    );
    expect(unknowns).toEqual(['bad_field']);
  });

  test('framework fields (id, createdAt, etc.) are allowed', () => {
    const unknowns = validateTemplateVariables(
      '{{ id }} {{ createdAt }} {{ updatedBy }}',
      [],
    );
    expect(unknowns).toEqual([]);
  });

  test('nested access: "record.title" checks "record"', () => {
    const unknowns = validateTemplateVariables(
      '{{ record.title }}',
      ['record'],
    );
    expect(unknowns).toEqual([]);

    const unknowns2 = validateTemplateVariables(
      '{{ missing.field }}',
      ['record'],
    );
    expect(unknowns2).toEqual(['missing']);
  });

  test('duplicate unknowns deduplicated', () => {
    const unknowns = validateTemplateVariables(
      '{{ bad }} and {{ bad }} and {{ bad }}',
      [],
    );
    expect(unknowns).toEqual(['bad']);
  });
});
