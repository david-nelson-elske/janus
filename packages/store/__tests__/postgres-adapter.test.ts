/**
 * Integration tests for the Postgres adapter.
 *
 * Requires a running Postgres instance. Set POSTGRES_URL env var to connect,
 * or the tests will be skipped.
 *
 * Example: POSTGRES_URL=postgres://postgres:postgres@localhost:5432/janus_test bun test postgres-adapter
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Str, Int, Bool, DateTime, Json, Markdown, Email, Persistent, Volatile, Enum, Lifecycle } from '@janus/vocabulary';
import { createPostgresAdapter } from '../postgres-adapter';
import type { AdapterMeta } from '../store-adapter';
import type { ReconcilableAdapter } from '../store-adapter';

const POSTGRES_URL = process.env.POSTGRES_URL;

function meta(entity: string, schema: Record<string, unknown>, overrides?: Partial<AdapterMeta>): AdapterMeta {
  return {
    entity,
    table: entity,
    schema: schema as AdapterMeta['schema'],
    storage: Persistent(),
    ...overrides,
  };
}

// Skip all tests if no Postgres URL
const describeWithPg = POSTGRES_URL ? describe : describe.skip;

describeWithPg('PostgresAdapter', () => {
  let adapter: ReconcilableAdapter & { destroy(): Promise<void> };

  const noteMeta = meta('pg_test_note', {
    title: Str({ required: true }),
    body: Markdown(),
    email: Email(),
    count: Int(),
    active: Bool(),
    created_date: DateTime(),
    tags: Json(),
    priority: Enum(['low', 'medium', 'high']),
  });

  beforeAll(async () => {
    adapter = createPostgresAdapter({ url: POSTGRES_URL! });

    // Drop test tables if they exist from a prior run
    const { Kysely, sql } = await import('kysely');
    const { PostgresJSDialect } = await import('kysely-postgres-js');
    const postgres = (await import('postgres')).default;
    const pgSql = postgres(POSTGRES_URL!);
    const db = new Kysely({ dialect: new PostgresJSDialect({ postgres: pgSql }) });
    try {
      await sql`DROP TABLE IF EXISTS pg_test_note CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS pg_test_search CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS _janus_schema CASCADE`.execute(db);
    } finally {
      await db.destroy();
      await pgSql.end();
    }
  });

  afterAll(async () => {
    if (adapter) await adapter.destroy();
  });

  describe('initialization', () => {
    test('creates table and FTS on finalize', async () => {
      await adapter.initialize(noteMeta);
      const report = await adapter.finalize();
      // First init — no prior snapshots, so no reconciliation
      expect(report).toBeNull();
    });
  });

  describe('CRUD operations', () => {
    test('create and read by id', async () => {
      const created = await adapter.create(noteMeta, {
        title: 'Hello Postgres',
        body: '# First note\nTesting the adapter.',
        email: 'test@example.com',
        count: 42,
        active: true,
        created_date: '2026-04-04T12:00:00Z',
        tags: { lang: 'en', draft: true },
        priority: 'high',
      });

      expect(created.id).toBeDefined();
      expect(created.title).toBe('Hello Postgres');
      expect(created._version).toBe(1);

      const read = await adapter.read(noteMeta, { id: created.id as string });
      expect(read).toMatchObject({
        id: created.id,
        title: 'Hello Postgres',
        body: '# First note\nTesting the adapter.',
        email: 'test@example.com',
        count: 42,
        active: true,
        priority: 'high',
      });

      // JSON field roundtrip
      expect((read as Record<string, unknown>).tags).toEqual({ lang: 'en', draft: true });
    });

    test('read returns a page when no id', async () => {
      const page = await adapter.read(noteMeta) as { records: unknown[]; total: number; hasMore: boolean };
      expect(page.records.length).toBeGreaterThanOrEqual(1);
      expect(typeof page.total).toBe('number');
      expect(typeof page.hasMore).toBe('boolean');
    });

    test('update increments version', async () => {
      const created = await adapter.create(noteMeta, { title: 'Update Me' });
      const updated = await adapter.update(noteMeta, created.id as string, { title: 'Updated!' });
      expect(updated._version).toBe(2);
      expect(updated.title).toBe('Updated!');
    });

    test('update with version conflict throws', async () => {
      const created = await adapter.create(noteMeta, { title: 'Conflict Test' });
      await adapter.update(noteMeta, created.id as string, { title: 'v2' });

      await expect(
        adapter.update(noteMeta, created.id as string, { title: 'v2b' }, { expectedVersion: 1 })
      ).rejects.toThrow('version conflict');
    });

    test('soft delete and re-read', async () => {
      const created = await adapter.create(noteMeta, { title: 'Delete Me' });
      await adapter.delete(noteMeta, created.id as string);

      // Should throw — record is soft-deleted
      await expect(
        adapter.read(noteMeta, { id: created.id as string })
      ).rejects.toThrow('not found');
    });
  });

  describe('filtering', () => {
    test('where clause with operators', async () => {
      await adapter.create(noteMeta, { title: 'Filter A', count: 10, priority: 'low' });
      await adapter.create(noteMeta, { title: 'Filter B', count: 20, priority: 'high' });
      await adapter.create(noteMeta, { title: 'Filter C', count: 30, priority: 'high' });

      // $gt
      const page = await adapter.read(noteMeta, { where: { count: { $gt: 15 } } }) as { records: Record<string, unknown>[] };
      const titles = page.records.map((r) => r.title);
      expect(titles).toContain('Filter B');
      expect(titles).toContain('Filter C');
      expect(titles).not.toContain('Filter A');
    });

    test('count with where clause', async () => {
      const n = await adapter.count(noteMeta, { priority: 'high' });
      expect(n).toBeGreaterThanOrEqual(2);
    });

    test('updateWhere', async () => {
      const updated = await adapter.updateWhere(noteMeta, { priority: 'low' }, { priority: 'medium' });
      expect(updated).toBeGreaterThanOrEqual(1);
    });
  });

  describe('full-text search', () => {
    const searchMeta = meta('pg_test_search', {
      title: Str({ required: true }),
      body: Markdown(),
    });

    beforeEach(async () => {
      // Initialize search entity (idempotent)
      await adapter.initialize(searchMeta);
      await adapter.finalize();
    });

    test('finds records by search term', async () => {
      await adapter.create(searchMeta, { title: 'Postgres Full-Text Search', body: 'Testing tsvector and GIN indexes in the adapter.' });
      await adapter.create(searchMeta, { title: 'Something Else', body: 'Unrelated content about databases.' });

      const page = await adapter.read(searchMeta, { search: 'tsvector' }) as { records: Record<string, unknown>[] };
      expect(page.records.length).toBeGreaterThanOrEqual(1);
      expect(page.records.some((r) => (r.title as string).includes('Full-Text'))).toBe(true);
    });
  });

  describe('transactions', () => {
    test('commit on success', async () => {
      const id = crypto.randomUUID();
      await adapter.withTransaction(async (tx) => {
        await tx.create(noteMeta, { id, title: 'Tx Created' });
      });

      const record = await adapter.read(noteMeta, { id });
      expect((record as Record<string, unknown>).title).toBe('Tx Created');
    });

    test('rollback on error', async () => {
      const id = crypto.randomUUID();
      try {
        await adapter.withTransaction(async (tx) => {
          await tx.create(noteMeta, { id, title: 'Should Rollback' });
          throw new Error('abort');
        });
      } catch {
        // expected
      }

      await expect(adapter.read(noteMeta, { id })).rejects.toThrow('not found');
    });
  });
});
