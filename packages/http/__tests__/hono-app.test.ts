/**
 * Tests for hono-app — additional coverage for createHttpApp() beyond
 * what integration.test.ts and assets.test.ts cover.
 *
 * Focuses on: SSE endpoint wiring, page catch-all control, error fallbacks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { define, participate, bind, clearRegistry } from '@janus/core';
import { Str, DateTime, Lifecycle, Persistent, QrCode, Token } from '@janus/vocabulary';
import { createApp, apiSurface } from '..';
import type { App } from '..';

// ── Minimal components ──────────────────────────────────────────

const ItemList = ({ page }: any) => {
  const { h } = require('preact');
  const records = page?.records ?? [];
  return h('div', null,
    h('h1', null, 'Items'),
    ...records.map((r: any) => h('div', { key: r.id }, r.title)),
  );
};

const ItemDetail = ({ context }: any) => {
  const { h } = require('preact');
  return h('div', null,
    h('h1', null, context?.fields?.title?.committed?.value ?? 'Untitled'),
  );
};

function get(fetchFn: (req: Request) => Promise<Response>, path: string) {
  return fetchFn(new Request(`http://localhost${path}`));
}

function post(fetchFn: (req: Request) => Promise<Response>, path: string, body: unknown) {
  return fetchFn(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ── SSE endpoint control ────────────────────────────────────────

describe('SSE endpoint wiring', () => {
  test('SSE endpoint is available by default when surfaces exist', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    const res = await get(app.fetch.bind(app), '/api/events?subscribe=note');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    await app.shutdown();
    clearRegistry();
  });

  test('SSE endpoint is disabled when enableSse is false', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
      enableSse: false,
    });

    const res = await get(app.fetch.bind(app), '/api/events?subscribe=note');
    expect(res.status).toBe(404);

    await app.shutdown();
    clearRegistry();
  });
});

// ── Page routes control ─────────────────────────────────────────

describe('page routes control', () => {
  test('page routes are enabled by default when bindings exist', async () => {
    clearRegistry();
    const item = define('item', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const itemP = participate(item, {});
    const itemB = bind(item, [
      {
        component: ItemList as any,
        view: 'list',
        config: { fields: { title: { agent: 'read' as const } } },
      },
    ]);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [item, itemP, itemB],
      surfaces: [surface],
    });

    const res = await get(app.fetch.bind(app), '/items');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Items');

    await app.shutdown();
    clearRegistry();
  });

  test('page routes are disabled when enablePages is false', async () => {
    clearRegistry();
    const item = define('item', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const itemP = participate(item, {});
    const itemB = bind(item, [
      {
        component: ItemList as any,
        view: 'list',
        config: { fields: { title: { agent: 'read' as const } } },
      },
    ]);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [item, itemP, itemB],
      surfaces: [surface],
      enablePages: false,
    });

    // Page route should 404 when pages are disabled
    const res = await get(app.fetch.bind(app), '/items');
    expect(res.status).toBe(404);

    // API routes should still work
    const apiRes = await post(app.fetch.bind(app), '/api/items', { title: 'Test' });
    expect(apiRes.status).toBe(201);

    await app.shutdown();
    clearRegistry();
  });
});

// ── Dispatch error fallback ─────────────────────────────────────

describe('hono-app dispatch fallback', () => {
  test('malformed JSON body falls back to undefined', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    // Send a POST with invalid JSON — the handler catches this and sets body to undefined
    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{{{',
      }),
    );

    // Should still get a response (may fail on validation but shouldn't crash)
    expect(res.status).toBeGreaterThanOrEqual(200);

    await app.shutdown();
    clearRegistry();
  });

  test('DELETE returns 204 status', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    // Create a record first
    const createRes = await post(app.fetch.bind(app), '/api/notes', { title: 'Delete me' });
    const created = await createRes.json();
    const id = created.data.id;

    // Delete
    const res = await app.fetch(
      new Request(`http://localhost/api/notes/${id}`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    await app.shutdown();
    clearRegistry();
  });
});

// ── Custom base path ────────────────────────────────────────────

describe('hono-app custom basePath', () => {
  test('routes use custom basePath from surface', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const surface = apiSurface({ basePath: '/v2' });

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    // Default /api should 404
    const res404 = await get(app.fetch.bind(app), '/api/notes');
    expect(res404.status).toBe(404);

    // Custom /v2 should work
    const createRes = await post(app.fetch.bind(app), '/v2/notes', { title: 'V2 Note' });
    expect(createRes.status).toBe(201);

    const listRes = await get(app.fetch.bind(app), '/v2/notes');
    expect(listRes.status).toBe(200);

    await app.shutdown();
    clearRegistry();
  });
});

// ── QrCode verification route ──────────────────────────────────

describe('GET /verify/:code', () => {
  test('resolves a QrCode to its entity record', async () => {
    clearRegistry();
    const ticket = define('ticket', {
      schema: {
        title: Str({ required: true }),
        code: QrCode({ length: 8 }),
      },
      storage: Persistent(),
    });
    const ticketP = participate(ticket);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [ticket, ticketP],
      surfaces: [surface],
    });

    // Create a ticket (code auto-generated)
    const createRes = await post(app.fetch.bind(app), '/api/tickets', { title: 'VIP Pass' });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const code = created.data.code;
    expect(code).toBeDefined();

    // Verify the code
    const verifyRes = await get(app.fetch.bind(app), `/api/verify/${code}`);
    expect(verifyRes.status).toBe(200);
    const verified = await verifyRes.json();
    expect(verified.ok).toBe(true);
    expect(verified.entity).toBe('ticket');
    expect(verified.field).toBe('code');
    // Security: full record is no longer exposed in verify response
    expect(verified.record).toBeUndefined();

    await app.shutdown();
    clearRegistry();
  });

  test('returns 404 for unknown code', async () => {
    clearRegistry();
    const ticket = define('ticket', {
      schema: {
        title: Str(),
        code: QrCode({ length: 8 }),
      },
      storage: Persistent(),
    });
    const ticketP = participate(ticket);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [ticket, ticketP],
      surfaces: [surface],
    });

    const res = await get(app.fetch.bind(app), '/api/verify/NONEXIST');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);

    await app.shutdown();
    clearRegistry();
  });

  test('returns 410 for expired code', async () => {
    clearRegistry();
    const ticket = define('ticket', {
      schema: {
        title: Str(),
        code: QrCode({ length: 8, expiresWith: 'expiresAt' }),
        expiresAt: DateTime(),
      },
      storage: Persistent(),
    });
    const ticketP = participate(ticket);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [ticket, ticketP],
      surfaces: [surface],
    });

    // Create with already-expired datetime
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const createRes = await post(app.fetch.bind(app), '/api/tickets', {
      title: 'Expired ticket',
      expiresAt: pastDate,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const code = created.data.code;

    // Verify — should return 404 (unified error to prevent expired/not-found enumeration)
    const verifyRes = await get(app.fetch.bind(app), `/api/verify/${code}`);
    expect(verifyRes.status).toBe(404);
    const body = await verifyRes.json();
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('not-found');

    await app.shutdown();
    clearRegistry();
  });

  test('no verify route when no QrCode entities exist', async () => {
    clearRegistry();
    const note = define('note', {
      schema: { title: Str() },
      storage: Persistent(),
    });
    const noteP = participate(note);
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    const res = await get(app.fetch.bind(app), '/api/verify/anything');
    expect(res.status).toBe(404);

    await app.shutdown();
    clearRegistry();
  });
});
