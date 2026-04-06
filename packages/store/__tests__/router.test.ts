import { beforeEach, describe, expect, test } from 'bun:test';
import { Str, Int, Persistent, Volatile } from '@janus/vocabulary';
import { hours } from '@janus/vocabulary';
import { createEntityStore } from '..';
import type { AdapterMeta, StoreAdapter, EntityStoreConfig } from '..';
import type { EntityStore, EntityRecord, ReadPage, RoutingRecord } from '@janus/core';

// ── Mock adapters ────────────────────────────────────────────────

function createMockAdapter(): StoreAdapter & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    calls,
    async initialize(meta: AdapterMeta) {
      calls.push({ method: 'initialize', args: [meta] });
    },
    async read(meta: AdapterMeta, params?: unknown) {
      calls.push({ method: 'read', args: [meta, params] });
      if (params && typeof params === 'object' && 'id' in params) {
        return { id: (params as any).id, _version: 1, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' } as EntityRecord;
      }
      return { records: [], total: 0, hasMore: false } as ReadPage;
    },
    async create(meta: AdapterMeta, record: unknown) {
      calls.push({ method: 'create', args: [meta, record] });
      return { id: 'new-id', _version: 1, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...(record as object) } as EntityRecord;
    },
    async update(meta: AdapterMeta, id: string, patch: unknown) {
      calls.push({ method: 'update', args: [meta, id, patch] });
      return { id, _version: 2, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...(patch as object) } as EntityRecord;
    },
    async delete(meta: AdapterMeta, id: string) {
      calls.push({ method: 'delete', args: [meta, id] });
    },
    async count(meta: AdapterMeta, where: unknown) {
      calls.push({ method: 'count', args: [meta, where] });
      return 0;
    },
    async updateWhere(meta: AdapterMeta, where: unknown, patch: unknown) {
      calls.push({ method: 'updateWhere', args: [meta, where, patch] });
      return 0;
    },
  };
}

function createMockTxAdapter() {
  const base = createMockAdapter();
  return {
    ...base,
    async finalize() { return null; },
    async withTransaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
      return fn(base);
    },
  };
}

const noteRouting: RoutingRecord = {
  entity: 'note',
  table: 'note',
  adapter: 'relational',
  schema: { title: Str(), count: Int() },
  storage: Persistent(),
};

const counterRouting: RoutingRecord = {
  entity: 'counter',
  table: 'counter',
  adapter: 'memory',
  schema: { value: Int() },
  storage: Volatile({ retain: hours(24) }),
};

// ── Tests ────────────────────────────────────────────────────────

describe('createEntityStore routing', () => {
  test('routes entity to correct adapter', async () => {
    const relational = createMockTxAdapter();
    const memory = createMockAdapter();

    const store = createEntityStore({
      routing: [noteRouting, counterRouting],
      adapters: { relational, memory },
    });

    await store.read('note', { id: 'x' });
    await store.read('counter');

    expect(relational.calls.some((c) => c.method === 'read')).toBe(true);
    expect(memory.calls.some((c) => c.method === 'read')).toBe(true);
  });

  test('unknown entity throws', async () => {
    const store = createEntityStore({
      routing: [noteRouting],
      adapters: { relational: createMockTxAdapter() },
    });

    await expect(store.read('nonexistent')).rejects.toThrow('Unknown entity');
  });

  test('no adapter for kind throws error at construction', () => {
    expect(() =>
      createEntityStore({
        routing: [{ ...noteRouting, adapter: 'relational' }],
        adapters: { memory: createMockAdapter() },
      }),
    ).toThrow(/No adapter/);
  });
});

describe('createEntityStore CRUD delegation', () => {
  let relational: ReturnType<typeof createMockTxAdapter>;
  let store: EntityStore;

  beforeEach(() => {
    relational = createMockTxAdapter();
    store = createEntityStore({
      routing: [noteRouting],
      adapters: { relational },
    });
  });

  test('read delegates', async () => {
    await store.read('note', { id: 'abc' });
    expect(relational.calls.filter((c) => c.method === 'read')).toHaveLength(1);
  });

  test('create delegates', async () => {
    await store.create('note', { title: 'Test' });
    expect(relational.calls.filter((c) => c.method === 'create')).toHaveLength(1);
  });

  test('update delegates', async () => {
    await store.update('note', 'abc', { title: 'Updated' });
    expect(relational.calls.filter((c) => c.method === 'update')).toHaveLength(1);
  });

  test('delete delegates', async () => {
    await store.delete('note', 'abc');
    expect(relational.calls.filter((c) => c.method === 'delete')).toHaveLength(1);
  });

  test('count delegates', async () => {
    await store.count('note', { title: 'X' });
    expect(relational.calls.filter((c) => c.method === 'count')).toHaveLength(1);
  });

  test('updateWhere delegates', async () => {
    await store.updateWhere('note', { title: 'X' }, { title: 'Y' });
    expect(relational.calls.filter((c) => c.method === 'updateWhere')).toHaveLength(1);
  });
});

describe('createEntityStore initialize', () => {
  test('calls initialize on all adapters', async () => {
    const relational = createMockTxAdapter();
    const memory = createMockAdapter();
    const store = createEntityStore({
      routing: [noteRouting, counterRouting],
      adapters: { relational, memory },
    });

    await store.initialize();
    expect(relational.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
    expect(memory.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
  });
});

describe('createEntityStore transactions', () => {
  test('delegates to relational adapter', async () => {
    let txCalled = false;
    const relational = {
      ...createMockAdapter(),
      async finalize() { return null; },
      async withTransaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
        txCalled = true;
        return fn(createMockAdapter());
      },
    };

    const store = createEntityStore({
      routing: [noteRouting],
      adapters: { relational },
    });

    await store.withTransaction(async (tx) => {
      await tx.read('note');
    });

    expect(txCalled).toBe(true);
  });

  test('runs without transaction when no relational adapter', async () => {
    const memory = createMockAdapter();
    const store = createEntityStore({
      routing: [counterRouting],
      adapters: { memory },
    });

    // Should not throw — runs fn directly
    await store.withTransaction(async (tx) => {
      await tx.read('counter');
    });

    expect(memory.calls.filter((c) => c.method === 'read')).toHaveLength(1);
  });

  test('mixed routing: relational entities use tx adapter, memory uses regular', async () => {
    const relational = createMockTxAdapter();
    const memory = createMockAdapter();

    const store = createEntityStore({
      routing: [noteRouting, counterRouting],
      adapters: { relational, memory },
    });

    await store.withTransaction(async (tx) => {
      await tx.read('note');
      await tx.read('counter');
    });

    // relational adapter gets the read via tx (its own mock delegates to base)
    expect(relational.calls.filter((c) => c.method === 'read')).toHaveLength(1);
    // memory adapter gets read via the outer store (not tx)
    expect(memory.calls.filter((c) => c.method === 'read')).toHaveLength(1);
  });

  test('transaction store delegates all CRUD methods', async () => {
    const relational = createMockTxAdapter();

    const store = createEntityStore({
      routing: [noteRouting],
      adapters: { relational },
    });

    await store.withTransaction(async (tx) => {
      await tx.create('note', { title: 'InTx' });
      await tx.update('note', 'abc', { title: 'Updated' });
      await tx.delete('note', 'abc');
      await tx.count('note', { title: 'X' });
      await tx.updateWhere('note', { title: 'X' }, { title: 'Y' });
    });

    const methods = relational.calls.map((c) => c.method);
    expect(methods).toContain('create');
    expect(methods).toContain('update');
    expect(methods).toContain('delete');
    expect(methods).toContain('count');
    expect(methods).toContain('updateWhere');
  });
});
