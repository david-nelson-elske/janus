import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Str, Int, Json, Markdown, Bool, Persistent, Volatile, Singleton } from '@janus/vocabulary';
import { hours } from '@janus/vocabulary';
import { createSqliteAdapter } from '..';
import type { AdapterMeta, StoreAdapter } from '..';
import type { EntityRecord, ReadPage } from '..';
import type { ReconcilableAdapter } from '../store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let adapter: ReconcilableAdapter;
let dbPath: string;

const noteMeta: AdapterMeta = {
  entity: 'note',
  table: 'note',
  schema: {
    title: Str({ required: true }),
    body: Markdown(),
    count: Int(),
    active: Bool(),
  },
  storage: Persistent(),
};

const counterMeta: AdapterMeta = {
  entity: 'counter',
  table: 'counter',
  schema: { value: Int() },
  storage: Volatile({ retain: hours(24) }),
};

const configMeta: AdapterMeta = {
  entity: 'config',
  table: 'config',
  schema: { data: Json(), name: Str() },
  storage: Singleton({ defaults: { name: 'default', data: { foo: 'bar' } } }),
};

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `janus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  adapter = createSqliteAdapter({ path: dbPath });
  await adapter.initialize(noteMeta);
  await adapter.initialize(counterMeta);
  await adapter.initialize(configMeta);
  await adapter.finalize();
});

afterEach(() => {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('sqlite adapter CRUD', () => {
  test('creates a record and reads it back', async () => {
    const created = await adapter.create(noteMeta, { title: 'Hello' });
    expect(created.id).toBeDefined();
    expect(created.title).toBe('Hello');
    expect(created._version).toBe(1);

    const read = await adapter.read(noteMeta, { id: created.id }) as EntityRecord;
    expect(read.title).toBe('Hello');
    expect(read.id).toBe(created.id);
  });

  test('read by id throws for missing record', async () => {
    await expect(adapter.read(noteMeta, { id: 'nonexistent' })).rejects.toThrow();
  });

  test('read list returns page', async () => {
    await adapter.create(noteMeta, { title: 'A' });
    await adapter.create(noteMeta, { title: 'B' });

    const result = await adapter.read(noteMeta) as ReadPage;
    expect(result.records).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  test('update modifies record', async () => {
    const created = await adapter.create(noteMeta, { title: 'Original' });
    const updated = await adapter.update(noteMeta, created.id, { title: 'Modified' });
    expect(updated.title).toBe('Modified');
    expect(updated._version).toBe(2);
    expect(updated.id).toBe(created.id);
  });

  test('update non-existent throws', async () => {
    await expect(adapter.update(noteMeta, 'missing', { title: 'X' })).rejects.toThrow();
  });

  test('delete soft-deletes persistent records', async () => {
    const created = await adapter.create(noteMeta, { title: 'ToDelete' });
    await adapter.delete(noteMeta, created.id);
    // Should not be readable
    await expect(adapter.read(noteMeta, { id: created.id })).rejects.toThrow();
  });

  test('delete non-existent throws', async () => {
    await expect(adapter.delete(noteMeta, 'missing')).rejects.toThrow();
  });
});

describe('sqlite adapter version conflict', () => {
  test('throws on version mismatch', async () => {
    const created = await adapter.create(noteMeta, { title: 'Test' });
    await expect(
      adapter.update(noteMeta, created.id, { title: 'X' }, { expectedVersion: 99 }),
    ).rejects.toThrow('version conflict');
  });

  test('succeeds with correct expected version', async () => {
    const created = await adapter.create(noteMeta, { title: 'Test' });
    const updated = await adapter.update(noteMeta, created.id, { title: 'X' }, { expectedVersion: 1 });
    expect(updated._version).toBe(2);
  });
});

describe('sqlite adapter FTS search', () => {
  test('searches Str and Markdown fields', async () => {
    await adapter.create(noteMeta, { title: 'Alpha article', body: 'Some content' });
    await adapter.create(noteMeta, { title: 'Beta document', body: 'Other text' });

    const result = await adapter.read(noteMeta, { search: 'Alpha' }) as ReadPage;
    expect(result.records).toHaveLength(1);
    expect(result.records[0].title).toBe('Alpha article');
  });

  test('returns empty when no match', async () => {
    await adapter.create(noteMeta, { title: 'Something' });
    const result = await adapter.read(noteMeta, { search: 'nonexistent_xyz' }) as ReadPage;
    expect(result.records).toHaveLength(0);
  });
});

describe('sqlite adapter JSON fields', () => {
  test('serializes and deserializes JSON', async () => {
    const payload = { nested: { a: 1, b: [2, 3] } };
    const created = await adapter.create(configMeta, {
      id: 'json-test',
      data: payload,
      name: 'test',
    });
    // Read it back
    const read = await adapter.read(configMeta, { id: 'json-test' }) as EntityRecord;
    expect(read.data).toEqual(payload);
  });
});

describe('sqlite adapter Singleton seeding', () => {
  test('auto-creates singleton record', async () => {
    const result = await adapter.read(configMeta, { id: `_s:config` }) as EntityRecord;
    expect(result).toBeDefined();
    expect(result.name).toBe('default');
    expect(result.data).toEqual({ foo: 'bar' });
  });
});

describe('sqlite adapter pagination', () => {
  test('limit and hasMore', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.create(noteMeta, { title: `Note ${i}` });
    }

    const result = await adapter.read(noteMeta, { limit: 2 }) as ReadPage;
    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(5);
  });

  test('offset skips records', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.create(noteMeta, { title: `Note ${i}` });
    }

    const result = await adapter.read(noteMeta, { limit: 2, offset: 3 }) as ReadPage;
    expect(result.records).toHaveLength(2);
    expect(result.offset).toBe(3);
  });
});

describe('sqlite adapter sorting', () => {
  test('sort by field ascending', async () => {
    await adapter.create(noteMeta, { title: 'Charlie' });
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Beta' });

    const result = await adapter.read(noteMeta, {
      sort: [{ field: 'title', direction: 'asc' }],
    }) as ReadPage;
    expect(result.records[0].title).toBe('Alpha');
    expect(result.records[1].title).toBe('Beta');
    expect(result.records[2].title).toBe('Charlie');
  });

  test('sort by field descending', async () => {
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Charlie' });

    const result = await adapter.read(noteMeta, {
      sort: [{ field: 'title', direction: 'desc' }],
    }) as ReadPage;
    expect(result.records[0].title).toBe('Charlie');
    expect(result.records[1].title).toBe('Alpha');
  });
});

describe('sqlite adapter where clause', () => {
  test('filters by field equality', async () => {
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Beta' });
    await adapter.create(noteMeta, { title: 'Alpha' });

    const result = await adapter.read(noteMeta, { where: { title: 'Alpha' } }) as ReadPage;
    expect(result.records).toHaveLength(2);
    expect(result.records.every((r) => r.title === 'Alpha')).toBe(true);
  });
});

describe('sqlite adapter count and updateWhere', () => {
  test('count returns matching records', async () => {
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Alpha' });
    await adapter.create(noteMeta, { title: 'Beta' });

    const count = await adapter.count(noteMeta, { title: 'Alpha' });
    expect(count).toBe(2);
  });

  test('updateWhere updates matching records', async () => {
    await adapter.create(noteMeta, { title: 'Old', count: 1 });
    await adapter.create(noteMeta, { title: 'Old', count: 2 });
    await adapter.create(noteMeta, { title: 'Keep', count: 3 });

    const updated = await adapter.updateWhere(noteMeta, { title: 'Old' }, { title: 'New' });
    expect(updated).toBeGreaterThanOrEqual(2);

    const result = await adapter.read(noteMeta, { where: { title: 'New' } }) as ReadPage;
    expect(result.records).toHaveLength(2);

    // 'Keep' should be unchanged
    const kept = await adapter.read(noteMeta, { where: { title: 'Keep' } }) as ReadPage;
    expect(kept.records).toHaveLength(1);
  });
});

describe('sqlite adapter transactions', () => {
  test('commits on success', async () => {
    await adapter.withTransaction(async (tx) => {
      await tx.create(noteMeta, { title: 'InTx' });
    });

    const result = await adapter.read(noteMeta) as ReadPage;
    expect(result.records.some((r) => r.title === 'InTx')).toBe(true);
  });

  test('rolls back on error', async () => {
    await adapter.create(noteMeta, { title: 'Before' });

    await expect(
      adapter.withTransaction(async (tx) => {
        await tx.create(noteMeta, { title: 'InFailed' });
        throw new Error('Rollback');
      }),
    ).rejects.toThrow('Rollback');

    const result = await adapter.read(noteMeta) as ReadPage;
    expect(result.records).toHaveLength(1);
    expect(result.records[0].title).toBe('Before');
  });
});

describe('sqlite adapter schema migration', () => {
  test('adds new column on re-initialize', async () => {
    // Create a record first
    await adapter.create(noteMeta, { title: 'Existing' });

    // Re-initialize with an extra field
    const extendedMeta: AdapterMeta = {
      ...noteMeta,
      schema: {
        ...noteMeta.schema,
        summary: Str(),
      },
    };

    const adapter2 = createSqliteAdapter({ path: dbPath });
    // Must re-initialize all entities to avoid ambiguous-removal errors
    await adapter2.initialize(extendedMeta);
    await adapter2.initialize(counterMeta);
    await adapter2.initialize(configMeta);
    await adapter2.finalize();

    // Should be able to write and read the new field
    const created = await adapter2.create(extendedMeta, { title: 'New', summary: 'A summary' });
    const read = await adapter2.read(extendedMeta, { id: created.id }) as EntityRecord;
    expect(read.summary).toBe('A summary');
  });
});
