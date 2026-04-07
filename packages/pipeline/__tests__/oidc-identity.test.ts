/**
 * Tests for OIDC identity resolution in http-identity concern.
 *
 * Exercises: JWT Bearer token extraction, JWKS validation, claim→Identity mapping,
 * role extraction (Keycloak realm_access.roles, custom paths), scope extraction,
 * expired token rejection, API key fallback, and missing auth → ANONYMOUS.
 *
 * Uses jose to create test JWTs signed with ephemeral RSA keys, served
 * from a local Hono JWKS endpoint.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import {
  define,
  participate,
  compile,
  clearRegistry,
  ANONYMOUS,
  SYSTEM,
} from '@janus/core';
import type { CompileResult, Identity } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
} from '..';
import type { DispatchRuntime } from '..';
import { Str, Persistent } from '@janus/vocabulary';
import { clearJwksCache } from '../concerns/http-identity';

// ── Test key infrastructure ─────────────────────────────────────

let privateKey: KeyLike;
let publicJwk: Record<string, unknown>;

const TEST_ISSUER = 'http://localhost:19876/realms/test';
const TEST_CLIENT_ID = 'janus-app';

let jwksServer: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  // Generate RSA key pair for signing JWTs
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  publicJwk = { ...jwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' };

  // Start a local JWKS server
  jwksServer = Bun.serve({
    port: 19876,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/realms/test/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
});

afterEach(() => {
  clearJwksCache();
  clearRegistry();
});

// ── Helpers ─────────────────────────────────────────────────────

async function signToken(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string; issuer?: string; audience?: string },
): Promise<string> {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(options?.issuer ?? TEST_ISSUER)
    .setAudience(options?.audience ?? TEST_CLIENT_ID)
    .setSubject(claims.sub as string ?? 'user-123');

  if (options?.expiresIn) {
    builder = builder.setExpirationTime(options.expiresIn);
  } else {
    builder = builder.setExpirationTime('1h');
  }

  return builder.sign(privateKey);
}

/** Bootstrap a dispatch runtime with http-identity configured for OIDC. */
async function bootstrapWithOidc(config: {
  oidc?: { issuer: string; clientId: string; rolesClaim?: string; scopesClaim?: string; roleMap?: Record<string, string> };
  keys?: Record<string, Identity>;
}) {
  registerHandlers();

  const note = define('note', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const noteP = participate(note, {});

  const identityConfig: Record<string, unknown> = {};
  if (config.keys) identityConfig.keys = config.keys;
  if (config.oidc) identityConfig.oidc = config.oidc;

  const initiator = {
    name: 'api-surface',
    origin: 'consumer' as const,
    participations: [
      { source: 'api-surface', handler: 'http-receive', order: 5, transactional: false, config: { basePath: '/api' } },
      { source: 'api-surface', handler: 'http-identity', order: 6, transactional: false, config: identityConfig },
      { source: 'api-surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
    ],
  };

  const registry = compile(
    [note, noteP, ...frameworkEntities, ...frameworkParticipations],
    [initiator],
  );

  const memAdapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memAdapter, memory: memAdapter },
  });
  await store.initialize();

  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry, store, broker });

  return { runtime, registry, store };
}

/** Dispatch with HTTP context (simulating what hono-app does). */
function httpDispatch(
  runtime: DispatchRuntime,
  entity: string,
  operation: string,
  input: unknown,
  headers: Record<string, string>,
) {
  return runtime.dispatch('api-surface', entity, operation, input, undefined, {
    httpRequest: { headers, params: {}, query: {}, body: input },
  });
}

// ── OIDC JWT tests ──────────────────────────────────────────────

describe('OIDC identity resolution', () => {
  test('valid Bearer token resolves to Identity with sub as id', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const token = await signToken({ sub: 'user-42', realm_access: { roles: ['editor'] } });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Test' }, {
      authorization: `Bearer ${token}`,
    });

    expect(result.ok).toBe(true);
    // The record's createdBy should be the OIDC user's sub
    const record = result.data as Record<string, unknown>;
    expect(record.createdBy).toBe('user-42');
  });

  test('extracts roles from realm_access.roles (Keycloak default)', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const token = await signToken({
      sub: 'user-1',
      realm_access: { roles: ['admin', 'manager'] },
    });

    // Create note with admin role — dispatches should succeed
    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Admin note' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
  });

  test('custom rolesClaim path extracts roles', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: {
        issuer: TEST_ISSUER,
        clientId: TEST_CLIENT_ID,
        rolesClaim: 'resource_access.janus.roles',
      },
    });

    const token = await signToken({
      sub: 'user-1',
      resource_access: { janus: { roles: ['writer', 'reviewer'] } },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Custom roles' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
  });

  test('missing roles claim defaults to user role', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    // No realm_access at all
    const token = await signToken({ sub: 'user-norole' });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'No roles' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('user-norole');
  });

  test('expired token falls back to ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    // Token that expired 1 hour ago
    const token = await signToken({ sub: 'user-expired' }, { expiresIn: '-1h' });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Expired' }, {
      authorization: `Bearer ${token}`,
    });
    // ANONYMOUS identity — createdBy should be 'anonymous'
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });

  test('wrong audience rejects token → ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const token = await signToken({ sub: 'user-1' }, { audience: 'wrong-client' });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Wrong aud' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });

  test('wrong issuer rejects token → ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const token = await signToken({ sub: 'user-1' }, { issuer: 'https://evil.example.com' });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Wrong iss' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });

  test('malformed token falls back to ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Bad token' }, {
      authorization: 'Bearer not-a-valid-jwt',
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });
});

// ── roleMap tests ──────────────────────────────────────────────

describe('roleMap', () => {
  test('maps OIDC roles to framework policy groups', async () => {
    clearRegistry();
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {
      policy: {
        rules: [{ role: 'board', operations: '*' }],
      },
    });

    const initiator = {
      name: 'api-surface',
      origin: 'consumer' as const,
      participations: [
        { source: 'api-surface', handler: 'http-receive', order: 5, transactional: false, config: { basePath: '/api' } },
        { source: 'api-surface', handler: 'http-identity', order: 6, transactional: false, config: {
          oidc: {
            issuer: TEST_ISSUER,
            clientId: TEST_CLIENT_ID,
            roleMap: { 'board-member': 'board' },
          },
        }},
        { source: 'api-surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
      ],
    };

    const registry = compile(
      [note, noteP, ...frameworkEntities, ...frameworkParticipations],
      [initiator],
    );

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // JWT has 'board-member' role, roleMap translates it to 'board'
    const token = await signToken({
      sub: 'user-1',
      realm_access: { roles: ['board-member'] },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Mapped role' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
  });

  test('unmapped roles pass through unchanged', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: {
        issuer: TEST_ISSUER,
        clientId: TEST_CLIENT_ID,
        roleMap: { 'other-role': 'mapped' },
      },
    });

    // 'admin' is not in roleMap, so it passes through as 'admin'
    const token = await signToken({
      sub: 'user-1',
      realm_access: { roles: ['admin'] },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Unmapped' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('user-1');
  });

  test('empty roleMap has no effect', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: {
        issuer: TEST_ISSUER,
        clientId: TEST_CLIENT_ID,
        roleMap: {},
      },
    });

    const token = await signToken({
      sub: 'user-1',
      realm_access: { roles: ['editor'] },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Empty map' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
  });
});

// ── API key fallback tests ──────────────────────────────────────

describe('API key fallback', () => {
  test('API key works when OIDC is also configured', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
      keys: { 'test-key': { id: 'apikey-user', roles: ['admin'] } },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'API key' }, {
      'x-api-key': 'test-key',
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('apikey-user');
  });

  test('Bearer token takes priority over API key', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
      keys: { 'test-key': { id: 'apikey-user', roles: ['admin'] } },
    });

    const token = await signToken({ sub: 'oidc-user', realm_access: { roles: ['admin'] } });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Both' }, {
      authorization: `Bearer ${token}`,
      'x-api-key': 'test-key',
    });
    expect(result.ok).toBe(true);
    // OIDC wins
    expect((result.data as Record<string, unknown>).createdBy).toBe('oidc-user');
  });

  test('API key only (no OIDC config) still works', async () => {
    const { runtime } = await bootstrapWithOidc({
      keys: { 'my-key': { id: 'key-user', roles: ['editor'] } },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Key only' }, {
      'x-api-key': 'my-key',
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('key-user');
  });
});

// ── ANONYMOUS fallback tests ────────────────────────────────────

describe('ANONYMOUS fallback', () => {
  test('no auth headers → ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Anon' }, {});
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });

  test('invalid API key → ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      keys: { 'valid-key': { id: 'user', roles: ['admin'] } },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Bad key' }, {
      'x-api-key': 'wrong-key',
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });

  test('Authorization header without Bearer prefix → ANONYMOUS', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Basic auth' }, {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');
  });
});

// ── Scope extraction ────────────────────────────────────────────

describe('scope extraction', () => {
  test('space-separated scope claim is parsed', async () => {
    const { runtime } = await bootstrapWithOidc({
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    });

    const token = await signToken({
      sub: 'user-scoped',
      realm_access: { roles: ['user'] },
      scope: 'openid profile email',
    });

    // We can't directly inspect the Identity from outside dispatch,
    // but we can verify the dispatch succeeded with the OIDC user
    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Scoped' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('user-scoped');
  });
});

// ── Integration: OIDC + policy-lookup ───────────────────────────

describe('OIDC + policy-lookup integration', () => {
  test('OIDC role satisfies policy rule', async () => {
    clearRegistry();
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {
      policy: {
        rules: [
          { role: 'editor', operations: ['create', 'update'] },
          { role: 'admin', operations: '*' },
        ],
        anonymousRead: true,
      },
    });

    const initiator = {
      name: 'api-surface',
      origin: 'consumer' as const,
      participations: [
        { source: 'api-surface', handler: 'http-receive', order: 5, transactional: false, config: { basePath: '/api' } },
        { source: 'api-surface', handler: 'http-identity', order: 6, transactional: false, config: {
          oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
        }},
        { source: 'api-surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
      ],
    };

    const registry = compile(
      [note, noteP, ...frameworkEntities, ...frameworkParticipations],
      [initiator],
    );

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // Editor role can create
    const editorToken = await signToken({
      sub: 'editor-1',
      realm_access: { roles: ['editor'] },
    });

    const createResult = await httpDispatch(runtime, 'note', 'create', { title: 'Editor note' }, {
      authorization: `Bearer ${editorToken}`,
    });
    expect(createResult.ok).toBe(true);

    // Anonymous can read (anonymousRead: true)
    const readResult = await httpDispatch(runtime, 'note', 'read', {}, {});
    expect(readResult.ok).toBe(true);

    // Anonymous cannot create (denied by policy)
    const anonCreate = await httpDispatch(runtime, 'note', 'create', { title: 'Anon' }, {});
    expect(anonCreate.ok).toBe(false);
    expect((anonCreate.error as Record<string, unknown>).kind).toBe('auth-error');
  });

  test('OIDC user without matching role is denied by policy', async () => {
    clearRegistry();
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {
      policy: {
        rules: [
          { role: 'admin', operations: '*' },
        ],
      },
    });

    const initiator = {
      name: 'api-surface',
      origin: 'consumer' as const,
      participations: [
        { source: 'api-surface', handler: 'http-receive', order: 5, transactional: false, config: { basePath: '/api' } },
        { source: 'api-surface', handler: 'http-identity', order: 6, transactional: false, config: {
          oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
        }},
        { source: 'api-surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
      ],
    };

    const registry = compile(
      [note, noteP, ...frameworkEntities, ...frameworkParticipations],
      [initiator],
    );

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // User with 'viewer' role — not in policy rules
    const viewerToken = await signToken({
      sub: 'viewer-1',
      realm_access: { roles: ['viewer'] },
    });

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Denied' }, {
      authorization: `Bearer ${viewerToken}`,
    });
    expect(result.ok).toBe(false);
    expect((result.error as Record<string, unknown>).kind).toBe('auth-error');
  });
});
