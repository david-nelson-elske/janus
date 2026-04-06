/**
 * Schema migration integration test — verifies ALTER TABLE ADD COLUMN
 * preserves existing data when entity schemas evolve.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import { registerHandlers, createDispatchRuntime } from '..';
import { createSqliteAdapter, createEntityStore } from '@janus/store';
import { Str, Markdown, Persistent } from '@janus/vocabulary';
import { unlinkSync } from 'fs';

afterEach(() => clearRegistry());

describe('schema migration integration', () => {
  test('adding a new column preserves existing data', async () => {
    const tmpPath = `/tmp/janus-migration-test-${Date.now()}.db`;

    try {
      // Phase 1: Create entity with title only, insert data
      clearRegistry();
      registerHandlers();

      const v1 = define('note', {
        schema: { title: Str({ required: true }) },
        storage: Persistent(),
      });
      const p1 = participate(v1, {});
      const reg1 = compile([v1, p1]);

      const adapter1 = createSqliteAdapter({ path: tmpPath });
      const store1 = createEntityStore({
        routing: reg1.persistRouting,
        adapters: { relational: adapter1, memory: adapter1 },
      });
      await store1.initialize();

      const runtime1 = createDispatchRuntime({ registry: reg1, store: store1 });
      const createRes = await runtime1.dispatch('system', 'note', 'create', { title: 'Original Note' });
      expect(createRes.ok).toBe(true);
      const recordId = (createRes.data as Record<string, unknown>).id;

      // Phase 2: Add 'body' column, boot against same database
      clearRegistry();
      registerHandlers();

      const v2 = define('note', {
        schema: {
          title: Str({ required: true }),
          body: Markdown(),  // NEW COLUMN
        },
        storage: Persistent(),
      });
      const p2 = participate(v2, {});
      const reg2 = compile([v2, p2]);

      const adapter2 = createSqliteAdapter({ path: tmpPath });
      const store2 = createEntityStore({
        routing: reg2.persistRouting,
        adapters: { relational: adapter2, memory: adapter2 },
      });
      await store2.initialize(); // Should ALTER TABLE ADD COLUMN, not fail

      const runtime2 = createDispatchRuntime({ registry: reg2, store: store2 });

      // Verify existing record is readable with new column as null
      const readRes = await runtime2.dispatch('system', 'note', 'read', { id: recordId });
      expect(readRes.ok).toBe(true);
      expect((readRes.data as Record<string, unknown>).title).toBe('Original Note');
      expect((readRes.data as Record<string, unknown>).body).toBeNull();

      // Verify new records can use the new column
      const newRes = await runtime2.dispatch('system', 'note', 'create', {
        title: 'New Note',
        body: 'With body content',
      });
      expect(newRes.ok).toBe(true);
      expect((newRes.data as Record<string, unknown>).body).toBe('With body content');

      // Verify old record can be updated with new column
      const updateRes = await runtime2.dispatch('system', 'note', 'update', {
        id: recordId,
        body: 'Backfilled body',
      });
      expect(updateRes.ok).toBe(true);
      expect((updateRes.data as Record<string, unknown>).body).toBe('Backfilled body');
      expect((updateRes.data as Record<string, unknown>).title).toBe('Original Note');
    } finally {
      try { unlinkSync(tmpPath); } catch {}
      try { unlinkSync(tmpPath + '-wal'); } catch {}
      try { unlinkSync(tmpPath + '-shm'); } catch {}
    }
  });
});
