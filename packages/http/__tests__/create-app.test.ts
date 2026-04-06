/**
 * Tests for createApp() bootstrap — additional coverage for configuration
 * paths not exercised by integration.test.ts.
 *
 * Focuses on: SSE enable/disable, page enable/disable, shutdown cleanup,
 * dispatch identity defaults.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, bind, clearRegistry } from '@janus/core';
import { Str, Persistent } from '@janus/vocabulary';
import { createApp, apiSurface } from '..';
import type { App } from '..';

afterEach(() => {
  clearRegistry();
});

// ── Helper ──────────────────────────────────────────────────────

function defineNote() {
  const note = define('note', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const noteP = participate(note, {});
  return [note, noteP] as const;
}

// ── Bootstrap variations ────────────────────────────────────────

describe('createApp bootstrap', () => {
  test('boots with no surfaces — dispatch only', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();

    const app = await createApp({ declarations: [note, noteP] });

    const res = await app.dispatch('note', 'create', { title: 'System dispatch' });
    expect(res.ok).toBe(true);
    expect((res.data as any).title).toBe('System dispatch');

    // HTTP fetch should return 404 since no surfaces
    const httpRes = await app.fetch(new Request('http://localhost/api/notes'));
    expect(httpRes.status).toBe(404);

    await app.shutdown();
  });

  test('dispatch uses SYSTEM identity by default', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();
    const app = await createApp({ declarations: [note, noteP] });

    const res = await app.dispatch('note', 'create', { title: 'Default identity' });
    expect(res.ok).toBe(true);
    // SYSTEM identity creates records with createdBy = 'system'
    expect((res.data as any).createdBy).toBe('system');

    await app.shutdown();
  });

  test('dispatch accepts custom identity', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();
    const app = await createApp({ declarations: [note, noteP] });

    const customIdentity = { id: 'custom-user', roles: ['editor'] };
    const res = await app.dispatch('note', 'create', { title: 'Custom user' }, customIdentity);
    expect(res.ok).toBe(true);
    expect((res.data as any).createdBy).toBe('custom-user');

    await app.shutdown();
  });
});

// ── Shutdown ────────────────────────────────────────────────────

describe('createApp shutdown', () => {
  test('shutdown completes without error', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
    });

    // Open an SSE connection to ensure there's something to clean up
    const sseRes = await app.fetch(
      new Request('http://localhost/api/events?subscribe=note'),
    );
    expect(app.connectionManager.size).toBe(1);

    await app.shutdown();
    expect(app.connectionManager.size).toBe(0);
  });

  test('shutdown without active connections completes fine', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();

    const app = await createApp({ declarations: [note, noteP] });
    expect(app.connectionManager.size).toBe(0);

    await app.shutdown();
    // Should not throw
  });

  test('shutdown without SSE bridge completes fine', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();
    const surface = apiSurface();

    const app = await createApp({
      declarations: [note, noteP],
      surfaces: [surface],
      enableSse: false,
    });

    await app.shutdown();
    // Should not throw
  });
});

// ── Store configuration ─────────────────────────────────────────

describe('createApp store', () => {
  test('defaults to in-memory store', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();

    const app = await createApp({ declarations: [note, noteP] });

    // Should be able to create and read back
    const createRes = await app.dispatch('note', 'create', { title: 'In-memory' });
    expect(createRes.ok).toBe(true);
    const id = (createRes.data as any).id;

    const readRes = await app.dispatch('note', 'read', { id });
    expect(readRes.ok).toBe(true);
    expect((readRes.data as any).title).toBe('In-memory');

    await app.shutdown();
  });
});

// ── Registry exposure ───────────────────────────────────────────

describe('createApp registry', () => {
  test('exposes registry, store, runtime, and broker', async () => {
    clearRegistry();
    const [note, noteP] = defineNote();

    const app = await createApp({ declarations: [note, noteP] });

    expect(app.registry).toBeDefined();
    expect(app.store).toBeDefined();
    expect(app.runtime).toBeDefined();
    expect(app.broker).toBeDefined();
    expect(app.connectionManager).toBeDefined();

    // Registry should contain the note entity
    expect(app.registry.entity('note')).toBeDefined();

    await app.shutdown();
  });
});
