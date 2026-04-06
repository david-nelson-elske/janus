/**
 * FTS5 full-text search tests.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import { registerHandlers, createDispatchRuntime, createBroker, frameworkEntities, frameworkParticipations } from '..';
import { createSqliteAdapter, createEntityStore } from '@janus/store';
import type { DispatchRuntime } from '..';
import { Str, Markdown, Persistent } from '@janus/vocabulary';
import { unlinkSync } from 'fs';

afterEach(() => clearRegistry());

async function setupWithFts() {
  clearRegistry();
  registerHandlers();

  const article = define('article', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      category: Str(),
    },
    storage: Persistent(),
  });
  const articleP = participate(article, {});

  const reg = compile([article, articleP, ...frameworkEntities, ...frameworkParticipations]);

  const tmpPath = `/tmp/janus-fts-test-${Date.now()}.db`;
  const adapter = createSqliteAdapter({ path: tmpPath });
  const store = createEntityStore({
    routing: reg.persistRouting,
    adapters: { relational: adapter, memory: adapter },
  });
  await store.initialize();
  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry: reg, store, broker });

  return { runtime, tmpPath };
}

function cleanupDb(tmpPath: string) {
  try { unlinkSync(tmpPath); } catch {}
  try { unlinkSync(tmpPath + '-wal'); } catch {}
  try { unlinkSync(tmpPath + '-shm'); } catch {}
}

/** Run a test body with a fresh FTS-enabled runtime, cleaning up the DB afterwards. */
async function withFts(fn: (runtime: DispatchRuntime) => Promise<void>) {
  const { runtime, tmpPath } = await setupWithFts();
  try {
    await fn(runtime);
  } finally {
    cleanupDb(tmpPath);
  }
}

describe('FTS5 search', () => {
  test('finds records by title content', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Introduction to Janus Framework' });
    await rt.dispatch('system', 'article', 'create', { title: 'Getting Started with React' });
    await rt.dispatch('system', 'article', 'create', { title: 'Advanced Janus Patterns' });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'Janus' });
    expect(res.ok).toBe(true);
    const page = res.data as { records: Record<string, unknown>[]; total: number };
    expect(page.records).toHaveLength(2);
  }));

  test('searches markdown body content', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', {
      title: 'Short Title',
      body: 'This article discusses the participation model and how entities wire to infrastructure.',
    });
    await rt.dispatch('system', 'article', 'create', {
      title: 'Other Article',
      body: 'This is about something completely different.',
    });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'participation' });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
    expect(page.records[0].title).toBe('Short Title');
  }));

  test('returns empty for no matches', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Hello World' });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'nonexistent' });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(0);
  }));

  test('search combined with where clause', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Guide', category: 'tutorial' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Reference', category: 'docs' });

    const res = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      where: { category: 'tutorial' },
    });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
    expect(page.records[0].title).toBe('Janus Guide');
  }));

  test('FTS is case-insensitive', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'JANUS FRAMEWORK' });
    await rt.dispatch('system', 'article', 'create', { title: 'janus patterns' });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'janus' });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(2);
  }));

  test('FTS prefix search with *', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Introduction' });
    await rt.dispatch('system', 'article', 'create', { title: 'Intermediate Patterns' });
    await rt.dispatch('system', 'article', 'create', { title: 'Advanced Topics' });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'Intro*' });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
    expect(page.records[0].title).toBe('Introduction');
  }));

  test('search with pagination (limit + offset)', () => withFts(async (rt) => {
    for (let i = 0; i < 5; i++) {
      await rt.dispatch('system', 'article', 'create', { title: `Janus Part ${i}` });
    }

    const page1 = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      limit: 2,
      offset: 0,
    });
    const p1 = page1.data as { records: Record<string, unknown>[]; total: number; hasMore: boolean };
    expect(p1.records).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p1.hasMore).toBe(true);

    const page2 = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      limit: 2,
      offset: 2,
    });
    const p2 = page2.data as { records: Record<string, unknown>[]; total: number; hasMore: boolean };
    expect(p2.records).toHaveLength(2);
    expect(p2.hasMore).toBe(true);

    const page3 = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      limit: 2,
      offset: 4,
    });
    const p3 = page3.data as { records: Record<string, unknown>[]; total: number };
    expect(p3.records).toHaveLength(1);
  }));

  test('search with explicit sort', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Beta' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Alpha' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Gamma' });

    const res = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      sort: [{ field: 'title', direction: 'asc' }],
    });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(3);
    expect(page.records[0].title).toBe('Janus Alpha');
    expect(page.records[1].title).toBe('Janus Beta');
    expect(page.records[2].title).toBe('Janus Gamma');
  }));

  test('search + where + sort combined', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Config', category: 'docs' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus API', category: 'docs' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Intro', category: 'tutorial' });

    const res = await rt.dispatch('system', 'article', 'read', {
      search: 'Janus',
      where: { category: 'docs' },
      sort: [{ field: 'title', direction: 'asc' }],
    });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(2);
    expect(page.records[0].title).toBe('Janus API');
    expect(page.records[1].title).toBe('Janus Config');
  }));

  test('multi-word search (implicit AND)', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Framework Guide' });
    await rt.dispatch('system', 'article', 'create', { title: 'Janus Quick Start' });
    await rt.dispatch('system', 'article', 'create', { title: 'React Framework Intro' });

    const res = await rt.dispatch('system', 'article', 'read', { search: 'Janus Framework' });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
    expect(page.records[0].title).toBe('Janus Framework Guide');
  }));

  test('Str() fields are searchable via FTS', () => withFts(async (rt) => {
    await rt.dispatch('system', 'article', 'create', {
      title: 'Hello World',
      category: 'specialcategoryvalue',
    });

    const res = await rt.dispatch('system', 'article', 'read', {
      search: 'specialcategoryvalue',
    });
    const page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
  }));

  test('FTS after record update reflects new content', () => withFts(async (rt) => {
    const created = await rt.dispatch('system', 'article', 'create', {
      title: 'Original Title',
    });
    const id = (created.data as Record<string, unknown>).id;

    let res = await rt.dispatch('system', 'article', 'read', { search: 'Original' });
    let page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);

    await rt.dispatch('system', 'article', 'update', { id, title: 'Updated Title' });

    res = await rt.dispatch('system', 'article', 'read', { search: 'Original' });
    page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(0);

    res = await rt.dispatch('system', 'article', 'read', { search: 'Updated' });
    page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);
  }));

  test('FTS after record deletion excludes deleted records', () => withFts(async (rt) => {
    const created = await rt.dispatch('system', 'article', 'create', {
      title: 'Doomed Article About Janus',
    });
    const id = (created.data as Record<string, unknown>).id;

    let res = await rt.dispatch('system', 'article', 'read', { search: 'Doomed' });
    let page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(1);

    await rt.dispatch('system', 'article', 'delete', { id });

    res = await rt.dispatch('system', 'article', 'read', { search: 'Doomed' });
    page = res.data as { records: Record<string, unknown>[] };
    expect(page.records).toHaveLength(0);
  }));
});
