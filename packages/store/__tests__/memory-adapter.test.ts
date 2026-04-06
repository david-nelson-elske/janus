import { beforeEach, describe, expect, test } from 'bun:test';
import { Str, Int, Persistent, Volatile } from '@janus/vocabulary';
import { createMemoryAdapter } from '..';
import type { StoreAdapter, TransactionalAdapter, AdapterMeta } from '..';
import type { EntityRecord, ReadPage } from '..';
import { hours } from '@janus/vocabulary';

let adapter: StoreAdapter & TransactionalAdapter;

const noteMeta: AdapterMeta = {
  entity: 'note',
  table: 'note',
  schema: { title: Str({ required: true }), count: Int() },
  storage: Persistent(),
};

const counterMeta: AdapterMeta = {
  entity: 'counter',
  table: 'counter',
  schema: { value: Int() },
  storage: Volatile({ retain: hours(24) }),
};

beforeEach(async () => {
  adapter = createMemoryAdapter();
  await adapter.initialize(noteMeta);
  await adapter.initialize(counterMeta);
});

describe('memory adapter read', () => {
  test('read by id returns single record', async () => {
    const created = await adapter.create(noteMeta, { title: 'Test' });
    const result = await adapter.read(noteMeta, { id: created.id });
    expect((result as EntityRecord).title).toBe('Test');
  });

  test('read by id throws for missing record', async () => {
    await expect(adapter.read(noteMeta, { id: 'nonexistent' })).rejects.toThrow();
  });

  test('read without id returns page', async () => {
    await adapter.create(noteMeta, { title: 'A' });
    await adapter.create(noteMeta, { title: 'B' });

    const result = await adapter.read(noteMeta);
    const page = result as ReadPage;
    expect(page.records).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  test('read with where filters', async () => {
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Beta' });

    const result = await adapter.read(noteMeta, { where: { title: 'Alpha' } });
    const page = result as ReadPage;
    expect(page.records).toHaveLength(1);
    expect(page.records[0].title).toBe('Alpha');
  });

  test('read with sort', async () => {
    await adapter.create(noteMeta, { title: 'B' });
    await adapter.create(noteMeta, { title: 'A' });

    const result = await adapter.read(noteMeta, { sort: [{ field: 'title', direction: 'asc' }] });
    const page = result as ReadPage;
    expect(page.records[0].title).toBe('A');
    expect(page.records[1].title).toBe('B');
  });

  test('read with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.create(noteMeta, { title: `Note ${i}` });
    }

    const result = await adapter.read(noteMeta, { limit: 2 });
    const page = result as ReadPage;
    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(5);
  });
});

describe('memory adapter write', () => {
  test('create generates id', async () => {
    const record = await adapter.create(noteMeta, { title: 'Test' });
    expect(record.id).toBeDefined();
    expect(record._version).toBe(1);
    expect(record.createdAt).toBeDefined();
  });

  test('create with explicit id', async () => {
    const record = await adapter.create(noteMeta, { id: 'custom-id', title: 'Test' });
    expect(record.id).toBe('custom-id');
  });

  test('update modifies record', async () => {
    const created = await adapter.create(noteMeta, { title: 'Original' });
    const updated = await adapter.update(noteMeta, created.id, { title: 'Modified' });
    expect(updated.title).toBe('Modified');
    expect(updated._version).toBe(2);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test('update non-existent throws', async () => {
    await expect(adapter.update(noteMeta, 'missing', { title: 'X' })).rejects.toThrow();
  });

  test('version conflict throws', async () => {
    const created = await adapter.create(noteMeta, { title: 'Test' });
    await expect(
      adapter.update(noteMeta, created.id, { title: 'X' }, { expectedVersion: 99 }),
    ).rejects.toThrow('version conflict');
  });
});

describe('memory adapter delete', () => {
  test('delete soft-deletes persistent records', async () => {
    const created = await adapter.create(noteMeta, { title: 'ToDelete' });
    await adapter.delete(noteMeta, created.id);

    // Should not be readable
    await expect(adapter.read(noteMeta, { id: created.id })).rejects.toThrow();
  });

  test('delete hard-deletes volatile records', async () => {
    const created = await adapter.create(counterMeta, { value: 1 });
    await adapter.delete(counterMeta, created.id);

    await expect(adapter.read(counterMeta, { id: created.id })).rejects.toThrow();
  });
});

describe('memory adapter transactions', () => {
  test('transaction rolls back on error', async () => {
    await adapter.create(noteMeta, { title: 'Existing' });

    await expect(
      adapter.withTransaction(async (tx) => {
        await tx.create(noteMeta, { title: 'InTransaction' });
        throw new Error('Rollback');
      }),
    ).rejects.toThrow('Rollback');

    // Only the original record should exist
    const result = await adapter.read(noteMeta);
    expect((result as ReadPage).records).toHaveLength(1);
  });

  test('transaction commits on success', async () => {
    await adapter.withTransaction(async (tx) => {
      await tx.create(noteMeta, { title: 'Committed' });
    });

    const result = await adapter.read(noteMeta);
    expect((result as ReadPage).records).toHaveLength(1);
  });
});
