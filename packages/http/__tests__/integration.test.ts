/**
 * Integration tests for HTTP surface — exercises app.fetch() end-to-end.
 *
 * Tests: route dispatch, CRUD via HTTP, lifecycle transitions, identity resolution,
 * status codes, and the createApp bootstrap.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { define, participate, clearRegistry } from '@janus/core';
import { Str, Int, Markdown, Lifecycle, Persistent } from '@janus/vocabulary';
import { createApp, apiSurface } from '..';
import type { App } from '..';

let app: App;

beforeEach(async () => {
  clearRegistry();

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      priority: Int(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    },
    storage: Persistent(),
  });

  const noteP = participate(note, {});

  const surface = apiSurface({
    identity: {
      keys: {
        'valid-key': { id: 'user1', roles: ['admin'] },
      },
    },
  });

  app = await createApp({
    declarations: [note, noteP],
    surfaces: [surface],
  });
});

afterEach(async () => {
  await app.shutdown();
  clearRegistry();
});

// ── Helpers ──────────────────────────────────────────────────────

function get(path: string, headers?: Record<string, string>) {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function patch(path: string, body: unknown, headers?: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function del(path: string, headers?: Record<string, string>) {
  return app.fetch(new Request(`http://localhost${path}`, { method: 'DELETE', headers }));
}

// ── CRUD ─────────────────────────────────────────────────────────

describe('HTTP CRUD', () => {
  test('POST /api/notes creates a record and returns 201', async () => {
    const res = await post('/api/notes', { title: 'Test note', body: 'Hello' });
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.title).toBe('Test note');
    expect(json.data.id).toBeDefined();
  });

  test('GET /api/notes returns a page with 200', async () => {
    await post('/api/notes', { title: 'Note 1' });
    await post('/api/notes', { title: 'Note 2' });

    const res = await get('/api/notes');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.records).toHaveLength(2);
  });

  test('GET /api/notes/:id returns a single record', async () => {
    const createRes = await post('/api/notes', { title: 'Test' });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await get(`/api/notes/${id}`);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.title).toBe('Test');
  });

  test('PATCH /api/notes/:id updates and returns 200', async () => {
    const createRes = await post('/api/notes', { title: 'Original' });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await patch(`/api/notes/${id}`, { title: 'Updated' });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.title).toBe('Updated');
  });

  test('DELETE /api/notes/:id returns 204', async () => {
    const createRes = await post('/api/notes', { title: 'To delete' });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await del(`/api/notes/${id}`);
    expect(res.status).toBe(204);
  });
});

// ── Lifecycle transitions ────────────────────────────────────────

describe('HTTP lifecycle transitions', () => {
  test('POST /api/notes/:id/published transitions lifecycle', async () => {
    const createRes = await post('/api/notes', { title: 'Draft note' });
    const created = await createRes.json();
    const id = created.data.id;
    expect(created.data.status).toBe('draft');

    const res = await post(`/api/notes/${id}/published`, {});
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe('published');
  });

  test('POST /api/notes/:id/archived transitions from published', async () => {
    const createRes = await post('/api/notes', { title: 'Note' });
    const created = await createRes.json();
    const id = created.data.id;

    await post(`/api/notes/${id}/published`, {});
    const res = await post(`/api/notes/${id}/archived`, {});
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.data.status).toBe('archived');
  });
});

// ── Identity resolution ──────────────────────────────────────────

describe('HTTP identity', () => {
  test('request with valid API key resolves identity', async () => {
    const res = await post('/api/notes', { title: 'Keyed' }, { 'X-API-Key': 'valid-key' });
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('user1');
  });

  test('request without API key gets anonymous identity', async () => {
    const res = await post('/api/notes', { title: 'Anonymous' });
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('anonymous');
  });

  test('request with unknown API key gets anonymous identity', async () => {
    const res = await post('/api/notes', { title: 'Unknown key' }, { 'X-API-Key': 'bad-key' });
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('anonymous');
  });
});

// ── Error responses ──────────────────────────────────────────────

describe('HTTP error responses', () => {
  test('404 for unknown entity routes', async () => {
    const res = await get('/api/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── createApp bootstrap ──────────────────────────────────────────

describe('createApp', () => {
  test('boots with no surfaces (system-only dispatch)', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const noHttpApp = await createApp({ declarations: [note, noteP] });

    const res = await noHttpApp.dispatch('note', 'create', { title: 'Direct' });
    expect(res.ok).toBe(true);
    expect((res.data as any).title).toBe('Direct');

    await noHttpApp.shutdown();
  });

  test('app.dispatch() uses system initiator', async () => {
    const res = await app.dispatch('note', 'create', { title: 'Via dispatch' });
    expect(res.ok).toBe(true);
    expect((res.data as any).title).toBe('Via dispatch');
  });

  test('app.fetch() delegates to Hono', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Via fetch' }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ── http config (surface collapse) ──────────────────────────────

describe('createApp with http config', () => {
  test('http config creates working routes without apiSurface()', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const httpApp = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
      apiKeys: { 'test-key': { id: 'user1', roles: ['admin'] } },
    });

    const res = await httpApp.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-key' },
        body: JSON.stringify({ title: 'Via http config' }),
      }),
    );
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.title).toBe('Via http config');
    expect(json.data.createdBy).toBe('user1');

    await httpApp.shutdown();
  });

  test('http config defaults basePath to /api', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const httpApp = await createApp({
      declarations: [note, noteP],
      http: {},
    });

    const res = await httpApp.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Default basePath' }),
      }),
    );
    expect(res.status).toBe(201);

    await httpApp.shutdown();
  });

  test('http config works without apiKeys', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const httpApp = await createApp({
      declarations: [note, noteP],
      http: {},
    });

    const res = await httpApp.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'No keys' }),
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.createdBy).toBe('anonymous');

    await httpApp.shutdown();
  });
});
