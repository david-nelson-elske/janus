/**
 * Tests for page handler — error paths and edge cases not covered by
 * ssr-integration.test.ts.
 *
 * Focuses on: missing bindings, detail view 404, dispatch errors.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { define, participate, bind, clearRegistry } from '@janus/core';
import { Str, Lifecycle, Persistent } from '@janus/vocabulary';
import { createApp, apiSurface } from '..';
import type { App } from '..';

// ── Minimal components ──────────────────────────────────────────

const TaskList = ({ page }: any) => {
  const { h } = require('preact');
  const records = page?.records ?? [];
  return h('div', null,
    h('h1', null, 'Tasks'),
    ...records.map((r: any) => h('div', { key: r.id }, r.title)),
  );
};

const TaskDetail = ({ context }: any) => {
  const { h } = require('preact');
  return h('div', null,
    h('h1', null, context?.fields?.title?.committed?.value ?? 'Untitled'),
  );
};

let app: App;

function get(path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ── Detail 404 when record not found ────────────────────────────

describe('page handler detail 404', () => {
  beforeEach(async () => {
    clearRegistry();

    const task = define('task', {
      schema: {
        title: Str({ required: true }),
        status: Lifecycle({ pending: ['done'] }),
      },
      storage: Persistent(),
    });

    const taskP = participate(task, {});
    const taskB = bind(task, [
      {
        component: TaskList as any,
        view: 'list',
        config: {
          fields: { title: { agent: 'read' as const }, status: { agent: 'read' as const } },
        },
      },
      {
        component: TaskDetail as any,
        view: 'detail',
        config: {
          fields: { title: { agent: 'read-write' as const, component: 'heading' } },
        },
      },
    ]);

    const surface = apiSurface();
    app = await createApp({
      declarations: [task, taskP, taskB],
      surfaces: [surface],
    });
  });

  afterEach(async () => {
    await app.shutdown();
    clearRegistry();
  });

  test('GET /tasks/:id with nonexistent id returns 404', async () => {
    const res = await get('/tasks/nonexistent-id-abc');
    // StoreException.kind propagates through dispatch as 'not-found'
    // Page handler detects this and returns 404
    expect(res.status).toBe(404);
  });

  test('GET /tasks/:id with valid id returns 200', async () => {
    const createRes = await post('/api/tasks', { title: 'Real Task' });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await get(`/tasks/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Real Task');
  });
});

// ── Entity without bindings ─────────────────────────────────────

describe('page handler no bindings', () => {
  beforeEach(async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    // No bind() — entity has no bindings
    const surface = apiSurface();
    app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });
  });

  afterEach(async () => {
    await app.shutdown();
    clearRegistry();
  });

  test('page routes return 404 when no bindings exist', async () => {
    const res = await get('/notes');
    expect(res.status).toBe(404);
  });

  test('root path returns 404 when no bindings exist', async () => {
    const res = await get('/');
    expect(res.status).toBe(404);
  });

  test('API routes still work without bindings', async () => {
    const res = await post('/api/notes', { title: 'API Test' });
    expect(res.status).toBe(201);
  });
});

// ── Entity with only list binding (no detail) ───────────────────

describe('page handler partial bindings', () => {
  beforeEach(async () => {
    clearRegistry();

    const task = define('task', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const taskP = participate(task, {});
    const taskB = bind(task, [
      {
        component: TaskList as any,
        view: 'list',
        config: { fields: { title: { agent: 'read' as const } } },
      },
      // No detail binding
    ]);

    const surface = apiSurface();
    app = await createApp({
      declarations: [task, taskP, taskB],
      surfaces: [surface],
    });
  });

  afterEach(async () => {
    await app.shutdown();
    clearRegistry();
  });

  test('list view works with only list binding', async () => {
    await post('/api/tasks', { title: 'List Only' });
    const res = await get('/tasks');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('List Only');
  });

  test('detail view returns 404 when no detail binding exists', async () => {
    const createRes = await post('/api/tasks', { title: 'No Detail' });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await get(`/tasks/${id}`);
    expect(res.status).toBe(404);
  });
});
