import { describe, expect, test } from 'bun:test';
import { Str, Int, Json, Persistent, Bool, Markdown } from '@janus/vocabulary';
import { jsonFieldNames, deserializeRow } from '..';
import type { AdapterMeta } from '..';

// ── Helpers ──────────────────────────────────────────────────────

function makeMeta(schema: AdapterMeta['schema']): AdapterMeta {
  return {
    entity: 'test_entity',
    table: 'test_entity',
    schema,
    storage: Persistent(),
  };
}

// ── jsonFieldNames ───────────────────────────────────────────────

describe('jsonFieldNames', () => {
  test('detects Json-typed fields', () => {
    const meta = makeMeta({ data: Json(), config: Json(), title: Str() });
    const fields = jsonFieldNames(meta);
    expect(fields.has('data')).toBe(true);
    expect(fields.has('config')).toBe(true);
    expect(fields.has('title')).toBe(false);
  });

  test('returns empty set when no JSON fields', () => {
    const meta = makeMeta({ title: Str(), count: Int(), active: Bool() });
    const fields = jsonFieldNames(meta);
    expect(fields.size).toBe(0);
  });

  test('does not include non-semantic fields', () => {
    const meta = makeMeta({ name: Str(), body: Markdown() });
    const fields = jsonFieldNames(meta);
    expect(fields.size).toBe(0);
  });
});

// ── deserializeRow ───────────────────────────────────────────────

describe('deserializeRow', () => {
  test('parses JSON string values in JSON fields', () => {
    const jsonFields = new Set(['data']);
    const row = { id: '1', data: '{"key":"value"}', title: 'Hello' };
    const result = deserializeRow(row, jsonFields);
    expect(result.data).toEqual({ key: 'value' });
    expect(result.title).toBe('Hello');
  });

  test('passes through non-JSON fields unchanged', () => {
    const jsonFields = new Set(['data']);
    const row = { id: '1', title: 'Test', count: 42, data: '[]' };
    const result = deserializeRow(row, jsonFields);
    expect(result.title).toBe('Test');
    expect(result.count).toBe(42);
    expect(result.data).toEqual([]);
  });

  test('handles JSON parse errors gracefully (keeps string)', () => {
    const jsonFields = new Set(['data']);
    const row = { id: '1', data: 'not-valid-json{' };
    const result = deserializeRow(row, jsonFields);
    // Should keep the original string on parse failure
    expect(result.data).toBe('not-valid-json{');
  });

  test('passes through objects (Postgres behavior)', () => {
    const jsonFields = new Set(['data']);
    const obj = { key: 'value' };
    const row = { id: '1', data: obj };
    const result = deserializeRow(row, jsonFields);
    // Object values (non-string) pass through without JSON.parse
    expect(result.data).toBe(obj);
  });

  test('handles null values in JSON fields', () => {
    const jsonFields = new Set(['data']);
    const row = { id: '1', data: null };
    const result = deserializeRow(row, jsonFields);
    expect(result.data).toBeNull();
  });

  test('preserves all record fields', () => {
    const jsonFields = new Set<string>();
    const row = {
      id: 'abc',
      _version: 3,
      createdAt: '2026-01-01',
      createdBy: 'system',
      updatedAt: '2026-01-02',
      updatedBy: 'user1',
      title: 'Test',
    };
    const result = deserializeRow(row, jsonFields);
    expect(result.id).toBe('abc');
    expect(result._version).toBe(3);
    expect(result.title).toBe('Test');
  });
});
