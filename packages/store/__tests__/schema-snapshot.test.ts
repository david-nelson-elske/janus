import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { Str, Int, Json, Markdown, Persistent, Lifecycle, Reference, Enum } from '@janus/vocabulary';
import { createSchemaSnapshotStore, generateSnapshot } from '..';
import type { AdapterMeta, EntitySnapshot, SchemaSnapshotStore } from '..';

// ── bun:sqlite → Kysely bridge ─────────────────────────────────

function wrapBunSqlite(db: Database) {
  return {
    close: () => db.close(),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        reader: /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql),
        all: (params: readonly unknown[]) => stmt.all(...(params as any[])) as Record<string, unknown>[],
        run: (params: readonly unknown[]) => {
          const { changes, lastInsertRowid } = stmt.run(...(params as any[]));
          return { changes, lastInsertRowid };
        },
        iterate: function* (params: readonly unknown[]) {
          for (const row of stmt.all(...(params as any[]))) yield row;
        },
      };
    },
  };
}

function createTestDb() {
  const database = new Database(':memory:');
  const db = new Kysely({ dialect: new SqliteDialect({ database: wrapBunSqlite(database) as any }) });
  return { db, database };
}

// ── Helpers ──────────────────────────────────────────────────────

function makeMeta(schema: AdapterMeta['schema'], entity = 'test_entity'): AdapterMeta {
  return {
    entity,
    table: entity,
    schema,
    storage: Persistent(),
  };
}

// ── generateSnapshot() ──────────────────────────────────────────

describe('generateSnapshot', () => {
  test('captures semantic fields with kind, sqlType, required', () => {
    const meta = makeMeta({ title: Str({ required: true }), count: Int() });
    const snap = generateSnapshot(meta);
    const titleField = snap.fields.find((f) => f.name === 'title');
    expect(titleField).toBeDefined();
    expect(titleField!.kind).toBe('str');
    expect(titleField!.sqlType).toBe('TEXT');
    expect(titleField!.required).toBe(true);

    const countField = snap.fields.find((f) => f.name === 'count');
    expect(countField!.kind).toBe('int');
    expect(countField!.sqlType).toBe('INTEGER');
    expect(countField!.required).toBe(false);
  });

  test('captures lifecycle fields with states', () => {
    const meta = makeMeta({
      status: Lifecycle({ draft: ['published'], published: ['archived'], archived: [] }),
    });
    const snap = generateSnapshot(meta);
    const statusField = snap.fields.find((f) => f.name === 'status');
    expect(statusField).toBeDefined();
    expect(statusField!.kind).toBe('lifecycle');
    expect(statusField!.lifecycleStates).toContain('draft');
    expect(statusField!.lifecycleStates).toContain('published');
    expect(statusField!.lifecycleStates).toContain('archived');
  });

  test('captures wiring types (Reference) with target', () => {
    const meta = makeMeta({ owner: Reference('user') });
    const snap = generateSnapshot(meta);
    const ownerField = snap.fields.find((f) => f.name === 'owner');
    expect(ownerField).toBeDefined();
    expect(ownerField!.kind).toBe('reference');
    expect(ownerField!.target).toBe('user');
  });

  test('captures enum fields with values', () => {
    const meta = makeMeta({ priority: Enum(['low', 'medium', 'high']) });
    const snap = generateSnapshot(meta);
    const field = snap.fields.find((f) => f.name === 'priority');
    expect(field).toBeDefined();
    expect(field!.kind).toBe('enum');
    expect(field!.enumValues).toEqual(['low', 'medium', 'high']);
  });

  test('returns entity name, table name, version=1, capturedAt', () => {
    const meta = makeMeta({ title: Str() }, 'my_entity');
    const snap = generateSnapshot(meta);
    expect(snap.entity).toBe('my_entity');
    expect(snap.table).toBe('my_entity');
    expect(snap.version).toBe(1);
    expect(snap.capturedAt).toBeTruthy();
    // capturedAt should be an ISO date string
    expect(new Date(snap.capturedAt).toISOString()).toBe(snap.capturedAt);
  });
});

// ── createSchemaSnapshotStore() ─────────────────────────────────

describe('createSchemaSnapshotStore', () => {
  let db: Kysely<any>;
  let database: Database;
  let store: SchemaSnapshotStore;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    database = created.database;
    store = createSchemaSnapshotStore(db);
    await store.initialize();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test('initialize creates the _janus_schema table', async () => {
    // If we can write and read, the table exists
    const snap: EntitySnapshot = {
      entity: 'note',
      table: 'note',
      fields: [{ name: 'title', kind: 'str', sqlType: 'TEXT', required: false }],
      version: 1,
      capturedAt: new Date().toISOString(),
    };
    await store.writeSnapshot(snap);
    const result = await store.readSnapshot('note');
    expect(result).not.toBeNull();
  });

  test('writeSnapshot + readSnapshot round-trip', async () => {
    const snap: EntitySnapshot = {
      entity: 'note',
      table: 'note',
      fields: [
        { name: 'title', kind: 'str', sqlType: 'TEXT', required: true },
        { name: 'count', kind: 'int', sqlType: 'INTEGER', required: false },
      ],
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.writeSnapshot(snap);
    const result = await store.readSnapshot('note');
    expect(result).not.toBeNull();
    expect(result!.entity).toBe('note');
    expect(result!.table).toBe('note');
    expect(result!.fields).toHaveLength(2);
    expect(result!.fields[0].name).toBe('title');
    expect(result!.fields[0].required).toBe(true);
    expect(result!.version).toBe(1);
    expect(result!.capturedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('readSnapshot returns null for unknown entity', async () => {
    const result = await store.readSnapshot('nonexistent');
    expect(result).toBeNull();
  });

  test('writeSnapshot upserts (overwrite existing)', async () => {
    const snap1: EntitySnapshot = {
      entity: 'note',
      table: 'note',
      fields: [{ name: 'title', kind: 'str', sqlType: 'TEXT', required: false }],
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.writeSnapshot(snap1);

    const snap2: EntitySnapshot = {
      entity: 'note',
      table: 'note',
      fields: [
        { name: 'title', kind: 'str', sqlType: 'TEXT', required: false },
        { name: 'body', kind: 'markdown', sqlType: 'TEXT', required: false },
      ],
      version: 2,
      capturedAt: '2026-02-01T00:00:00.000Z',
    };
    await store.writeSnapshot(snap2);

    const result = await store.readSnapshot('note');
    expect(result!.version).toBe(2);
    expect(result!.fields).toHaveLength(2);
  });

  test('readAllSnapshots returns all stored snapshots', async () => {
    await store.writeSnapshot({
      entity: 'note',
      table: 'note',
      fields: [],
      version: 1,
      capturedAt: new Date().toISOString(),
    });
    await store.writeSnapshot({
      entity: 'task',
      table: 'task',
      fields: [],
      version: 1,
      capturedAt: new Date().toISOString(),
    });

    const all = await store.readAllSnapshots();
    expect(all).toHaveLength(2);
    const entities = all.map((s) => s.entity).sort();
    expect(entities).toEqual(['note', 'task']);
  });

  test('deleteSnapshot removes a snapshot', async () => {
    await store.writeSnapshot({
      entity: 'note',
      table: 'note',
      fields: [],
      version: 1,
      capturedAt: new Date().toISOString(),
    });

    await store.deleteSnapshot('note');
    const result = await store.readSnapshot('note');
    expect(result).toBeNull();
  });
});
