/**
 * Integration tests for ADR 04c: Schema Reconciliation.
 *
 * These tests exercise the full reconciliation pipeline against a real SQLite database,
 * verifying DDL execution, data preservation, and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Str, Int, Markdown, Lifecycle, Relation, Persistent } from '@janus/vocabulary';
import type { EvolveConfig } from '@janus/core';
import type { AdapterMeta } from '../store-adapter';
import { createSchemaSnapshotStore, generateSnapshot } from '../schema-snapshot';
import type { SchemaSnapshotStore } from '../schema-snapshot';
import { generateCreateTable } from '../schema-gen';
import {
  reconcileSchema,
  planReconciliation,
  applyReconciliation,
  SchemaReconciliationError,
} from '../schema-reconcile';
// ── Test helpers ───────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: bun:sqlite Database type
function wrapBunSqlite(db: any): import('kysely').SqliteDatabase {
  return {
    close: () => db.close(),
    prepare: (querySql: string) => {
      const stmt = db.prepare(querySql);
      return {
        reader:
          /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)/i.test(querySql) || /\bRETURNING\b/i.test(querySql),
        all: (params: readonly unknown[]) =>
          stmt.all(...(params as unknown[])) as Record<string, unknown>[],
        run: (params: readonly unknown[]) => {
          const { changes, lastInsertRowid } = stmt.run(...(params as unknown[]));
          return { changes, lastInsertRowid };
        },
        iterate: function* (params: readonly unknown[]) {
          for (const row of stmt.all(...(params as unknown[]))) yield row;
        },
      };
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test DB type
let db: Kysely<any>;
let snapshotStore: SchemaSnapshotStore;

beforeEach(async () => {
  const Database = require('bun:sqlite').Database;
  const database = new Database(':memory:');
  database.exec('PRAGMA journal_mode = WAL');
  db = new Kysely({ dialect: new SqliteDialect({ database: wrapBunSqlite(database) }) });
  snapshotStore = createSchemaSnapshotStore(db);
  await snapshotStore.initialize();
});

afterEach(async () => {
  await db.destroy();
});

function makeMeta(entity: string, schema: Record<string, unknown>, evolve?: EvolveConfig): AdapterMeta {
  return {
    entity,
    table: entity,
    schema: schema as AdapterMeta['schema'],
    storage: Persistent(),
    evolve,
  };
}

async function createTable(meta: AdapterMeta): Promise<void> {
  await sql.raw(generateCreateTable(meta)).execute(db);
}

async function insertRow(table: string, data: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const full = {
    id: crypto.randomUUID(),
    _version: 1,
    createdAt: now,
    createdBy: 'test',
    updatedAt: now,
    updatedBy: 'test',
    ...data,
  };
  const cols = Object.keys(full).map((c) => `"${c}"`).join(', ');
  const vals = Object.values(full).map((v) => v === null || v === undefined ? 'NULL' : `'${v}'`).join(', ');
  await sql.raw(`INSERT INTO "${table}" (${cols}) VALUES (${vals})`).execute(db);
}

async function readAll(table: string): Promise<Record<string, unknown>[]> {
  const result = await sql.raw(`SELECT * FROM "${table}"`).execute(db);
  return result.rows as Record<string, unknown>[];
}

async function getColumns(table: string): Promise<string[]> {
  const result = await sql.raw(`PRAGMA table_info("${table}")`).execute(db);
  return (result.rows as { name: string }[]).map((r) => r.name);
}

// ── New entity ─────────────────────────────────────────────────

describe('new entity', () => {
  test('reconcile returns no changes for entity with no snapshot', async () => {
    const meta = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(meta);

    const report = await reconcileSchema(db, [meta], snapshotStore);
    expect(report.applied.some((c) => c.kind === 'add-entity')).toBe(true);
  });

  test('snapshot written after first reconciliation', async () => {
    const meta = makeMeta('note', { title: Str() });
    await createTable(meta);
    await reconcileSchema(db, [meta], snapshotStore);

    const snapshot = await snapshotStore.readSnapshot('note');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entity).toBe('note');
    expect(snapshot!.fields.some((f) => f.name === 'title')).toBe(true);
  });
});

// ── No change ──────────────────────────────────────────────────

describe('no change', () => {
  test('subsequent reconcile with same schema produces no changes', async () => {
    const meta = makeMeta('note', { title: Str() });
    await createTable(meta);
    await reconcileSchema(db, [meta], snapshotStore);

    // Second reconciliation
    const report = await reconcileSchema(db, [meta], snapshotStore);
    expect(report.applied).toHaveLength(0);
  });
});

// ── Add nullable column ────────────────────────────────────────

describe('add nullable column', () => {
  test('auto-applied via ALTER TABLE ADD COLUMN', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    // V2: add body column
    const v2 = makeMeta('note', { title: Str(), body: Markdown() });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'add-column' && c.field === 'body')).toBe(true);

    // Verify column exists
    const cols = await getColumns('note');
    expect(cols).toContain('body');
  });

  test('existing rows have NULL for new column', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello' });

    const v2 = makeMeta('note', { title: Str(), body: Markdown() });
    await reconcileSchema(db, [v2], snapshotStore);

    const rows = await readAll('note');
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBeNull();
  });
});

// ── Add required column ────────────────────────────────────────

describe('add required column', () => {
  test('without backfill is blocked', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str(), body: Str({ required: true }) });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
      const err = e as SchemaReconciliationError;
      expect(err.plan.cautious.some((c) => c.field === 'body')).toBe(true);
    }
  });

  test('with backfill is applied and existing rows get default value', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello' });

    const v2 = makeMeta('note', { title: Str(), body: Str({ required: true }) }, { backfills: { body: 'default' } });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.field === 'body')).toBe(true);

    const rows = await readAll('note');
    expect(rows[0].body).toBe('default');
  });
});

// ── Remove column ──────────────────────────────────────────────

describe('remove column', () => {
  test('without acknowledgment is blocked', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str() });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
      const err = e as SchemaReconciliationError;
      expect(err.plan.ambiguous.some((c) => c.field === 'body')).toBe(true);
    }
  });

  test('with evolve.drops is applied', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello', body: 'world' });

    const v2 = makeMeta('note', { title: Str() }, { drops: ['body'] });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'remove-column' && c.field === 'body')).toBe(true);

    const cols = await getColumns('note');
    expect(cols).not.toContain('body');
  });
});

// ── Rename column ──────────────────────────────────────────────

describe('rename column', () => {
  test('with evolve.renames preserves data', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello', body: 'world' });

    const v2 = makeMeta('note', { title: Str(), content: Markdown() }, { renames: { body: 'content' } });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'rename-column' && c.field === 'content')).toBe(true);

    // Verify data preserved under new name
    const cols = await getColumns('note');
    expect(cols).toContain('content');
    expect(cols).not.toContain('body');

    const rows = await readAll('note');
    expect(rows[0].content).toBe('world');
  });

  test('without evolve.renames is ambiguous', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    // body removed, content added — could be rename or drop+add
    const v2 = makeMeta('note', { title: Str(), content: Markdown() });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
    }
  });
});

// ── Type change ────────────────────────────────────────────────

describe('type change', () => {
  test('without coercion is blocked', async () => {
    const v1 = makeMeta('note', { title: Str(), count: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str(), count: Int() });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
    }
  });

  test('with coercion transforms existing data', async () => {
    const v1 = makeMeta('note', { title: Str(), count: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello', count: '42' });

    const v2 = makeMeta('note', { title: Str(), count: Int() }, {
      coercions: { count: (old) => Number(old) },
    });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'change-type')).toBe(true);

    const rows = await readAll('note');
    // SQLite stores the coerced value
    expect(Number(rows[0].count)).toBe(42);
  });
});

// ── Nullability change ─────────────────────────────────────────

describe('nullability change', () => {
  test('required → nullable is safe', async () => {
    const v1 = makeMeta('note', { title: Str({ required: true }) });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str() });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'change-nullability')).toBe(true);
  });

  test('nullable → required with backfill updates NULLs', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { title: 'hello', body: null });

    const v2 = makeMeta('note', { title: Str(), body: Str({ required: true }) }, {
      backfills: { body: 'empty' },
    });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'change-nullability')).toBe(true);

    const rows = await readAll('note');
    expect(rows[0].body).toBe('empty');
  });

  test('nullable → required without backfill is blocked', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str(), body: Str({ required: true }) });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
    }
  });
});

// ── Lifecycle state changes ────────────────────────────────────

describe('lifecycle state changes', () => {
  test('add state is safe', async () => {
    const v1 = makeMeta('note', {
      status: Lifecycle({ draft: ['published'], published: [] }),
    });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', {
      status: Lifecycle({ draft: ['published'], published: ['archived'], archived: [] }),
    });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'add-lifecycle-state')).toBe(true);
  });

  test('remove state without stateMap is blocked', async () => {
    const v1 = makeMeta('note', {
      status: Lifecycle({ draft: ['published', 'review'], published: [], review: ['published'] }),
    });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', {
      status: Lifecycle({ draft: ['published'], published: [] }),
    });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
      const err = e as SchemaReconciliationError;
      expect(err.plan.ambiguous.some((c) => c.kind === 'remove-lifecycle-state')).toBe(true);
    }
  });

  test('remove state with stateMap updates existing records', async () => {
    const v1 = makeMeta('note', {
      status: Lifecycle({ draft: ['review'], review: ['published'], published: [] }),
    });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);
    await insertRow('note', { status: 'review' });
    await insertRow('note', { status: 'draft' });

    const v2 = makeMeta('note', {
      status: Lifecycle({ draft: ['published'], published: [] }),
    }, {
      stateMap: { status: { review: 'draft' } },
    });
    const report = await reconcileSchema(db, [v2], snapshotStore);

    expect(report.applied.some((c) => c.kind === 'remove-lifecycle-state')).toBe(true);

    const rows = await readAll('note');
    // Both rows should now be 'draft' (the review row was mapped)
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });
});

// ── Entity removal ─────────────────────────────────────────────

describe('entity removal', () => {
  test('without drop() is blocked', async () => {
    const meta = makeMeta('note', { title: Str() });
    await createTable(meta);
    await reconcileSchema(db, [meta], snapshotStore);

    // Now reconcile with no entities (note removed)
    try {
      await reconcileSchema(db, [], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaReconciliationError);
      const err = e as SchemaReconciliationError;
      expect(err.plan.ambiguous.some((c) => c.kind === 'remove-entity')).toBe(true);
    }
  });

  test('with drop() removes from snapshot but preserves table', async () => {
    const meta = makeMeta('note', { title: Str() });
    await createTable(meta);
    await reconcileSchema(db, [meta], snapshotStore);
    await insertRow('note', { title: 'hello' });

    // Reconcile with drop
    const report = await reconcileSchema(db, [], snapshotStore, new Set(['note']));

    expect(report.applied.some((c) => c.kind === 'remove-entity')).toBe(true);

    // Snapshot removed
    const snapshot = await snapshotStore.readSnapshot('note');
    expect(snapshot).toBeNull();

    // Table still exists with data
    const rows = await readAll('note');
    expect(rows).toHaveLength(1);
  });
});

// ── Stale evolve config ────────────────────────────────────────

describe('stale evolve config', () => {
  test('is silently ignored', async () => {
    const meta = makeMeta('note', { title: Str() }, { renames: { old: 'title' }, drops: ['gone'] });
    await createTable(meta);
    await reconcileSchema(db, [meta], snapshotStore);

    // Second run with same stale evolve — no changes to apply
    const report = await reconcileSchema(db, [meta], snapshotStore);
    expect(report.applied).toHaveLength(0);
  });
});

// ── Production workflow ────────────────────────────────────────

describe('production workflow', () => {
  test('planReconciliation does not execute DDL', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str(), body: Markdown() });
    const plan = await planReconciliation(db, [v2], snapshotStore);

    expect(plan.safe.some((c) => c.field === 'body')).toBe(true);

    // Column should NOT exist yet
    const cols = await getColumns('note');
    expect(cols).not.toContain('body');
  });

  test('applyReconciliation executes the plan', async () => {
    const v1 = makeMeta('note', { title: Str() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    const v2 = makeMeta('note', { title: Str(), body: Markdown() });
    const plan = await planReconciliation(db, [v2], snapshotStore);
    await applyReconciliation(db, plan, [v2], snapshotStore);

    // Column should now exist
    const cols = await getColumns('note');
    expect(cols).toContain('body');
  });
});

// ── SchemaReconciliationError ──────────────────────────────────

describe('SchemaReconciliationError', () => {
  test('message includes entity, description, and resolution hint', async () => {
    const v1 = makeMeta('note', { title: Str(), body: Markdown() });
    await createTable(v1);
    await reconcileSchema(db, [v1], snapshotStore);

    // Remove body and add required tags — two blocked changes
    const v2 = makeMeta('note', { title: Str(), tags: Str({ required: true }) });

    try {
      await reconcileSchema(db, [v2], snapshotStore);
      expect.unreachable('should throw');
    } catch (e) {
      const err = e as SchemaReconciliationError;
      expect(err.message).toContain('body');
      expect(err.message).toContain('tags');
      expect(err.plan.changes.length).toBeGreaterThan(0);
    }
  });
});

// ── Multiple entities ──────────────────────────────────────────

describe('multiple entities', () => {
  test('reconciles each entity independently', async () => {
    const note = makeMeta('note', { title: Str() });
    const task = makeMeta('task', { name: Str() });
    await createTable(note);
    await createTable(task);
    await reconcileSchema(db, [note, task], snapshotStore);

    // Add column to note, leave task unchanged
    const noteV2 = makeMeta('note', { title: Str(), body: Markdown() });
    const report = await reconcileSchema(db, [noteV2, task], snapshotStore);

    expect(report.applied.some((c) => c.entity === 'note' && c.field === 'body')).toBe(true);
    // Task should have no changes
    expect(report.applied.filter((c) => c.entity === 'task')).toHaveLength(0);
  });
});
