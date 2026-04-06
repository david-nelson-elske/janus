import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import { registerHandlers, createDispatchRuntime } from '..';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import { Str, Persistent } from '@janus/vocabulary';

afterEach(() => clearRegistry());

describe('identity metadata', () => {
  test('create stamps createdBy/updatedBy from identity', async () => {
    clearRegistry();
    registerHandlers();
    const note = define('note', { schema: { title: Str({ required: true }) }, storage: Persistent() });
    const p = participate(note, {});
    const reg = compile([note, p]);
    const adapter = createMemoryAdapter();
    const store = createEntityStore({ routing: reg.persistRouting, adapters: { relational: adapter, memory: adapter } });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create',
      { title: 'Test' },
      { id: 'alice', roles: ['user'] },
    );
    expect(res.ok).toBe(true);
    const record = res.data as Record<string, unknown>;
    expect(record.createdBy).toBe('alice');
    expect(record.updatedBy).toBe('alice');
  });

  test('update stamps updatedBy but preserves createdBy', async () => {
    clearRegistry();
    registerHandlers();
    const note = define('note', { schema: { title: Str({ required: true }) }, storage: Persistent() });
    const p = participate(note, {});
    const reg = compile([note, p]);
    const adapter = createMemoryAdapter();
    const store = createEntityStore({ routing: reg.persistRouting, adapters: { relational: adapter, memory: adapter } });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const createRes = await runtime.dispatch('system', 'note', 'create',
      { title: 'Test' },
      { id: 'alice', roles: ['user'] },
    );
    const id = (createRes.data as Record<string, unknown>).id;

    const updateRes = await runtime.dispatch('system', 'note', 'update',
      { id, title: 'Updated' },
      { id: 'bob', roles: ['user'] },
    );
    expect(updateRes.ok).toBe(true);
    const record = updateRes.data as Record<string, unknown>;
    expect(record.createdBy).toBe('alice');  // preserved
    expect(record.updatedBy).toBe('bob');    // changed
  });

  test('system identity defaults when no identity provided', async () => {
    clearRegistry();
    registerHandlers();
    const note = define('note', { schema: { title: Str({ required: true }) }, storage: Persistent() });
    const p = participate(note, {});
    const reg = compile([note, p]);
    const adapter = createMemoryAdapter();
    const store = createEntityStore({ routing: reg.persistRouting, adapters: { relational: adapter, memory: adapter } });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test' });
    const record = res.data as Record<string, unknown>;
    expect(record.createdBy).toBe('system');
  });
});
