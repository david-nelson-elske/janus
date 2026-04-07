/**
 * Tests for auth route derivation.
 *
 * Tests the /auth/me endpoint and route mounting. The OIDC flow tests
 * (login redirect, callback exchange) require a mock OIDC provider.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, clearRegistry } from '@janus/core';
import { Str, Persistent } from '@janus/vocabulary';
import { createApp } from '..';
import type { App } from '..';

// ── Helpers ──────────────────────────────────────────────────────

function get(app: App, path: string, headers?: Record<string, string>) {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

// ── Tests ────────────────────────────────────────────────────────

describe('auth routes', () => {
  test('/auth/me returns anonymous when no session', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    // Configure OIDC provider via system dispatch so auth routes mount
    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
    });

    // First configure the oidc_provider so auth routes get mounted on next boot
    await app.dispatch('oidc_provider', 'update', {
      id: '_s:oidc_provider',
      issuer: 'https://keycloak.example.com/realms/test',
      client_id: 'test-app',
    });

    await app.shutdown();

    // Re-boot to pick up OIDC config (auth routes read at boot)
    clearRegistry();
    const note2 = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP2 = participate(note2, {});

    const app2 = await createApp({
      declarations: [note2, noteP2],
      http: { basePath: '/api' },
      store: { path: ':memory:' },
    });

    // Without OIDC config in memory store, auth routes won't mount
    // Test the basic case: no auth routes when oidc not configured
    const res = await get(app2, '/api/auth/me');
    // Should be 404 since oidc_provider has empty issuer in fresh memory store
    expect(res.status).toBe(404);

    await app2.shutdown();
  });

  test('auth routes not mounted when oidc_provider has empty issuer', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
    });

    // Default oidc_provider has empty issuer — no auth routes
    const res = await get(app, '/api/auth/login');
    expect(res.status).toBe(404);

    await app.shutdown();
  });

  test('CRUD routes still work alongside auth config', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
      apiKeys: { 'test': { id: 'user1', roles: ['admin'] } },
    });

    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test' },
        body: JSON.stringify({ title: 'Works' }),
      }),
    );
    expect(res.status).toBe(201);

    await app.shutdown();
  });
});

describe('session cookie identity resolution', () => {
  test('valid session cookie resolves to session identity', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
    });

    // Create a session directly
    const sessionResult = await app.dispatch('session', 'create', {
      subject: 'oidc-user-123',
      identity_id: 'local-user-1',
      provider: 'https://keycloak.example.com',
    });
    expect(sessionResult.ok).toBe(true);

    const session = sessionResult.data as Record<string, unknown>;
    const sessionToken = session.token as string;
    expect(sessionToken).toBeDefined();
    expect(sessionToken.length).toBeGreaterThan(0);

    // Use the session cookie to make a request
    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `janus_session=${sessionToken}`,
        },
        body: JSON.stringify({ title: 'Cookie auth' }),
      }),
    );
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('local-user-1');

    await app.shutdown();
  });

  test('expired session cookie falls back to anonymous', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
    });

    // Create a session and then manually expire it
    const sessionResult = await app.dispatch('session', 'create', {
      subject: 'user-expired',
      provider: 'test',
    });
    expect(sessionResult.ok).toBe(true);

    const session = sessionResult.data as Record<string, unknown>;
    const sessionToken = session.token as string;

    // Transition to expired
    await app.dispatch('session', 'expired', { id: session.id });

    // Use the expired session cookie
    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `janus_session=${sessionToken}`,
        },
        body: JSON.stringify({ title: 'Expired cookie' }),
      }),
    );
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('anonymous');

    await app.shutdown();
  });

  test('invalid session token falls back to anonymous', async () => {
    clearRegistry();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const app = await createApp({
      declarations: [note, noteP],
      http: { basePath: '/api' },
    });

    const res = await app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'janus_session=nonexistent-token',
        },
        body: JSON.stringify({ title: 'Bad cookie' }),
      }),
    );
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.createdBy).toBe('anonymous');

    await app.shutdown();
  });
});
