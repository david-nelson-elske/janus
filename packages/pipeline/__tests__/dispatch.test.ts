/**
 * Integration tests for the full dispatch pipeline.
 * Exercises: define → participate → compile → store → dispatch → read back.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import type { CompileResult } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import { registerHandlers, createDispatchRuntime } from '..';
import type { DispatchRuntime } from '..';
import { Str, Int, Markdown, Lifecycle, Relation, Persistent, Singleton } from '@janus/vocabulary';

let registry: CompileResult;
let store: EntityStore;
let runtime: DispatchRuntime;

beforeEach(async () => {
  clearRegistry();
  registerHandlers();

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    },
    storage: Persistent(),
  });

  const user = define('user', {
    schema: { name: Str({ required: true }), email: Str() },
    storage: Persistent(),
  });

  const noteP = participate(note, {});
  const userP = participate(user, {});

  registry = compile([note, user, noteP, userP]);

  const memoryAdapter = createMemoryAdapter();
  store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memoryAdapter, memory: memoryAdapter },
  });
  await store.initialize();

  runtime = createDispatchRuntime({ registry, store });
});

afterEach(() => {
  clearRegistry();
});

// ── CRUD roundtrip ──────────────────────────────────────────────

describe('dispatch CRUD', () => {
  test('create a record', async () => {
    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test note' });
    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
    const record = res.data as Record<string, unknown>;
    expect(record.title).toBe('Test note');
    expect(record.id).toBeDefined();
    expect(record.status).toBe('draft'); // lifecycle initial value
  });

  test('read all records', async () => {
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 1' });
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 2' });

    const res = await runtime.dispatch('system', 'note', 'read', {});
    expect(res.ok).toBe(true);
    const page = res.data as { records: unknown[]; total: number };
    expect(page.records).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  test('read single record by id', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'Test' });
    const id = (createRes.data as Record<string, unknown>).id;

    const res = await runtime.dispatch('system', 'note', 'read', { id });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).title).toBe('Test');
  });

  test('update a record', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'Original' });
    const id = (createRes.data as Record<string, unknown>).id;

    const res = await runtime.dispatch('system', 'note', 'update', { id, title: 'Updated' });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).title).toBe('Updated');
  });

  test('delete a record', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'ToDelete' });
    const id = (createRes.data as Record<string, unknown>).id;

    const res = await runtime.dispatch('system', 'note', 'delete', { id });
    expect(res.ok).toBe(true);

    // Should not be readable anymore (soft deleted)
    const readRes = await runtime.dispatch('system', 'note', 'read', { id });
    expect(readRes.ok).toBe(false);
  });
});

// ── Lifecycle transitions ───────────────────────────────────────

describe('dispatch lifecycle', () => {
  test('valid lifecycle transition via update', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'My Note' });
    const id = (createRes.data as Record<string, unknown>).id;

    const res = await runtime.dispatch('system', 'note', 'update', { id, status: 'published' });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).status).toBe('published');
  });

  test('invalid lifecycle transition rejected', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'My Note' });
    const id = (createRes.data as Record<string, unknown>).id;

    // draft → archived is not a valid transition
    const res = await runtime.dispatch('system', 'note', 'update', { id, status: 'archived' });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('lifecycle-violation');
  });

  test('lifecycle transition via named operation', async () => {
    const createRes = await runtime.dispatch('system', 'note', 'create', { title: 'My Note' });
    const id = (createRes.data as Record<string, unknown>).id;

    // 'published' is a transition target name that maps to update
    const res = await runtime.dispatch('system', 'note', 'published', { id });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).status).toBe('published');
  });
});

// ── Parse validation ────────────────────────────────────────────

describe('dispatch parse', () => {
  test('missing required field on create rejected', async () => {
    const res = await runtime.dispatch('system', 'note', 'create', {});
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('parse-error');
  });

  test('unknown fields are stripped', async () => {
    const res = await runtime.dispatch('system', 'note', 'create', {
      title: 'Test',
      unknownField: 'should be stripped',
    });
    expect(res.ok).toBe(true);
    const record = res.data as Record<string, unknown>;
    expect(record.title).toBe('Test');
    expect(record.unknownField).toBeUndefined();
  });
});

// ── Error handling ──────────────────────────────────────────────

describe('dispatch errors', () => {
  test('unknown entity returns error', async () => {
    const res = await runtime.dispatch('system', 'nonexistent', 'read', {});
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('unknown-entity');
  });

  test('unsupported operation returns error', async () => {
    const res = await runtime.dispatch('system', 'note', 'process', {});
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('unsupported-operation');
  });

  test('store not-found error propagates kind through dispatch', async () => {
    const res = await runtime.dispatch('system', 'note', 'read', { id: 'nonexistent' });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('not-found');
  });

  test('response includes meta', async () => {
    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test' });
    expect(res.meta.entity).toBe('note');
    expect(res.meta.operation).toBe('create');
    expect(res.meta.correlationId).toBeDefined();
    expect(res.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.meta.depth).toBe(0);
  });
});

// ── Multiple entities ───────────────────────────────────────────

describe('dispatch multi-entity', () => {
  test('different entities work independently', async () => {
    await runtime.dispatch('system', 'note', 'create', { title: 'A Note' });
    await runtime.dispatch('system', 'user', 'create', { name: 'Alice' });

    const notes = await runtime.dispatch('system', 'note', 'read', {});
    const users = await runtime.dispatch('system', 'user', 'read', {});

    expect((notes.data as { records: unknown[] }).records).toHaveLength(1);
    expect((users.data as { records: unknown[] }).records).toHaveLength(1);
  });
});
