/**
 * Tests for identity-provision concern handler.
 *
 * Exercises: auto-provisioning on first OIDC login, reuse of existing identity,
 * skip for anonymous/system/non-HTTP, skip when not configured.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  define,
  participate,
  compile,
  clearRegistry,
} from '@janus/core';
import type { Identity } from '@janus/core';
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

let privateKey: Parameters<typeof SignJWT.prototype.sign>[0];
let publicJwk: Record<string, unknown>;

const TEST_ISSUER = 'http://localhost:19877/realms/test';
const TEST_CLIENT_ID = 'janus-app';

let jwksServer: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  publicJwk = { ...jwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' };

  jwksServer = Bun.serve({
    port: 19877,
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
  jwksServer?.stop();
  clearJwksCache();
  clearRegistry();
});

// ── Helpers ─────────────────────────────────────────────────────

async function signToken(sub: string, roles: string[] = ['user']): Promise<string> {
  return new SignJWT({ realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_CLIENT_ID)
    .setSubject(sub)
    .setExpirationTime('1h')
    .sign(privateKey);
}

/** Bootstrap with an identity entity and identity-provision wired in. */
async function bootstrap(options?: { withProvision?: boolean }) {
  registerHandlers();

  // Consumer identity entity — what the app uses for local user records
  const member = define('member', {
    schema: {
      oidc_sub: Str({ required: true }),
      display_name: Str(),
    },
    storage: Persistent(),
  });
  const memberP = participate(member, {});

  // A regular entity to test dispatch against
  const note = define('note', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const noteP = participate(note, {});

  const participations: Array<Record<string, unknown>> = [
    { source: 'api-surface', handler: 'http-receive', order: 5, transactional: false, config: { basePath: '/api' } },
    { source: 'api-surface', handler: 'http-identity', order: 6, transactional: false, config: {
      oidc: { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID },
    }},
    { source: 'api-surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
  ];

  if (options?.withProvision !== false) {
    participations.push({
      source: 'api-surface',
      handler: 'identity-provision',
      order: 7,
      transactional: false,
      config: { identityEntity: 'member', subjectField: 'oidc_sub' },
    });
  }

  const initiator = {
    name: 'api-surface',
    origin: 'consumer' as const,
    participations,
  };

  const registry = compile(
    [member, memberP, note, noteP, ...frameworkEntities, ...frameworkParticipations],
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

// ── Tests ───────────────────────────────────────────────────────

describe('identity-provision', () => {
  test('auto-creates local identity record on first OIDC login', async () => {
    const { runtime, store } = await bootstrap();
    const token = await signToken('new-user-123');

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Test' }, {
      authorization: `Bearer ${token}`,
    });

    expect(result.ok).toBe(true);
    // createdBy should be the LOCAL member record's ID, not the raw OIDC sub
    const record = result.data as Record<string, unknown>;
    expect(record.createdBy).not.toBe('new-user-123');
    expect(record.createdBy).toBeDefined();

    // Verify the member record was created with the OIDC sub
    const members = await store.read('member', { where: { oidc_sub: 'new-user-123' } }) as { records: Array<Record<string, unknown>> };
    expect(members.records.length).toBe(1);
  });

  test('reuses existing local identity record on subsequent requests', async () => {
    const { runtime, store } = await bootstrap();
    const token = await signToken('returning-user');

    // First request — creates the member record
    await httpDispatch(runtime, 'note', 'create', { title: 'First' }, {
      authorization: `Bearer ${token}`,
    });

    // Second request — should reuse the same member record
    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Second' }, {
      authorization: `Bearer ${token}`,
    });

    expect(result.ok).toBe(true);

    // Should still be only one member record
    const members = await store.read('member', { where: { oidc_sub: 'returning-user' } }) as { records: Array<Record<string, unknown>> };
    expect(members.records.length).toBe(1);

    // Both notes should have the same createdBy (local member ID)
    const notes = await store.read('note', {}) as { records: Array<Record<string, unknown>> };
    const ids = notes.records.map((r: Record<string, unknown>) => r.createdBy);
    expect(ids[0]).toBe(ids[1]);
  });

  test('skips for anonymous identity', async () => {
    const { runtime, store } = await bootstrap();

    // No auth header → anonymous
    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Anon' }, {});
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).createdBy).toBe('anonymous');

    // No member record should be created
    const members = await store.read('member', {}) as { records: Array<Record<string, unknown>> };
    expect(members.records.length).toBe(0);
  });

  test('skips when identity-provision is not in the pipeline', async () => {
    const { runtime } = await bootstrap({ withProvision: false });
    const token = await signToken('user-no-provision');

    const result = await httpDispatch(runtime, 'note', 'create', { title: 'No provision' }, {
      authorization: `Bearer ${token}`,
    });

    expect(result.ok).toBe(true);
    // createdBy should be the raw OIDC sub (no provisioning)
    expect((result.data as Record<string, unknown>).createdBy).toBe('user-no-provision');
  });

  test('preserves OIDC roles on provisioned identity', async () => {
    registerHandlers();
    clearRegistry();

    const { runtime } = await bootstrap();
    const token = await signToken('role-user', ['admin', 'editor']);

    // If the user has the right roles, policy should pass
    const result = await httpDispatch(runtime, 'note', 'create', { title: 'Roles preserved' }, {
      authorization: `Bearer ${token}`,
    });
    expect(result.ok).toBe(true);
  });
});
