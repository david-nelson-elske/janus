/**
 * Tests for credential-generate handler.
 *
 * Exercises: Token auto-generation, QrCode auto-generation,
 * character set constraints, manual override, pipeline integration.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  compile,
  clearRegistry,
  SYSTEM,
} from '@janus/core';
import type { CompileResult, EntityStore } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  generateToken,
  generateQrCode,
  parseDuration,
} from '..';
import type { DispatchRuntime } from '..';
import { Token, QrCode, Str, DateTime, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Unit tests: generation functions ────────────────────────────

describe('generateToken()', () => {
  test('generates string of specified length', () => {
    const token = generateToken(32, '');
    expect(token).toHaveLength(32);
  });

  test('respects prefix', () => {
    const token = generateToken(16, 'tk_');
    expect(token.startsWith('tk_')).toBe(true);
    expect(token).toHaveLength(16 + 3); // length + prefix
  });

  test('uses only alphanumeric characters', () => {
    const token = generateToken(100, '');
    expect(token).toMatch(/^[A-Za-z0-9]+$/);
  });

  test('generates unique values', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken(32, ''));
    }
    expect(tokens.size).toBe(100);
  });
});

describe('generateQrCode()', () => {
  test('generates alphanumeric code of specified length', () => {
    const code = generateQrCode(12, 'alphanumeric');
    expect(code).toHaveLength(12);
  });

  test('excludes ambiguous characters (I, O, 0, 1)', () => {
    // Generate many codes to increase probability of catching violations
    for (let i = 0; i < 100; i++) {
      const code = generateQrCode(20, 'alphanumeric');
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  test('generates uppercase-only alphanumeric', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateQrCode(20, 'alphanumeric');
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    }
  });

  test('numeric format uses only digits', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateQrCode(8, 'numeric');
      expect(code).toMatch(/^[0-9]+$/);
      expect(code).toHaveLength(8);
    }
  });

  test('generates unique values', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateQrCode(12, 'alphanumeric'));
    }
    expect(codes.size).toBe(100);
  });
});

// ── Pipeline integration tests ──────────────────────────────────

async function setup(entityDefs: ReturnType<typeof define>[], participations: ReturnType<typeof participate>[]) {
  registerHandlers();

  const compiled = compile([...entityDefs, ...participations]);

  const memAdapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: compiled.persistRouting,
    adapters: { relational: memAdapter, memory: memAdapter },
  });
  await store.initialize();

  const runtime = createDispatchRuntime({ registry: compiled, store });

  return { compiled, store, runtime };
}

describe('credential-generate pipeline concern', () => {
  test('auto-generates Token field on create', async () => {
    const entity = define('api_key', {
      storage: Persistent(),
      schema: {
        label: Str(),
        secret: Token({ length: 24 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'api_key', 'create', { label: 'test key' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.label).toBe('test key');
    expect(data.secret).toBeDefined();
    expect(typeof data.secret).toBe('string');
    expect(data.secret as string).toHaveLength(24);
    expect(data.secret as string).toMatch(/^[A-Za-z0-9]+$/);
  });

  test('auto-generates Token with prefix', async () => {
    const entity = define('invite', {
      storage: Persistent(),
      schema: {
        email: Str(),
        code: Token({ prefix: 'inv_', length: 16 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'invite', 'create', { email: 'test@example.com' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect((data.code as string).startsWith('inv_')).toBe(true);
    expect(data.code as string).toHaveLength(16 + 4); // length + prefix
  });

  test('auto-generates QrCode field on create', async () => {
    const entity = define('ticket', {
      storage: Persistent(),
      schema: {
        title: Str(),
        code: QrCode({ length: 8 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'ticket', 'create', { title: 'Event ticket' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.code).toBeDefined();
    expect(data.code as string).toHaveLength(8);
    expect(data.code as string).toMatch(/^[A-HJ-NP-Z2-9]+$/);
  });

  test('auto-generates numeric QrCode', async () => {
    const entity = define('door_code', {
      storage: Persistent(),
      schema: {
        name: Str(),
        pin: QrCode({ length: 6, format: 'numeric' }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'door_code', 'create', { name: 'Front door' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.pin).toBeDefined();
    expect(data.pin as string).toHaveLength(6);
    expect(data.pin as string).toMatch(/^[0-9]+$/);
  });

  test('does not overwrite provided Token value', async () => {
    const entity = define('api_key', {
      storage: Persistent(),
      schema: {
        label: Str(),
        secret: Token({ length: 24 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'api_key', 'create', { label: 'manual', secret: 'my-custom-token' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.secret).toBe('my-custom-token');
  });

  test('does not overwrite provided QrCode value', async () => {
    const entity = define('ticket', {
      storage: Persistent(),
      schema: {
        title: Str(),
        code: QrCode({ length: 8 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'ticket', 'create', { title: 'Manual', code: 'CUSTOM01' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.code).toBe('CUSTOM01');
  });

  test('does not generate on update', async () => {
    const entity = define('api_key', {
      storage: Persistent(),
      schema: {
        label: Str(),
        secret: Token({ length: 24 }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);

    // Create with auto-generated token
    const createRes = await runtime.dispatch('system', 'api_key', 'create', { label: 'original' });
    expect(createRes.ok).toBe(true);
    const created = createRes.data as Record<string, unknown>;
    const originalSecret = created.secret as string;

    // Update the label — secret should not change
    const updateRes = await runtime.dispatch('system', 'api_key', 'update', { id: created.id, label: 'renamed' });
    expect(updateRes.ok).toBe(true);
    const updated = updateRes.data as Record<string, unknown>;

    expect(updated.secret).toBe(originalSecret);
    expect(updated.label).toBe('renamed');
  });

  test('generates both Token and QrCode on same entity', async () => {
    const entity = define('registration', {
      storage: Persistent(),
      schema: {
        name: Str(),
        apiToken: Token({ prefix: 'reg_', length: 20 }),
        checkinCode: QrCode({ length: 6, format: 'numeric' }),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'registration', 'create', { name: 'Alice' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.apiToken).toBeDefined();
    expect((data.apiToken as string).startsWith('reg_')).toBe(true);
    expect(data.checkinCode).toBeDefined();
    expect(data.checkinCode as string).toMatch(/^[0-9]+$/);
  });

  test('default Token length is 32', async () => {
    const entity = define('simple_token', {
      storage: Persistent(),
      schema: {
        key: Token(),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'simple_token', 'create', {});
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.key as string).toHaveLength(32);
  });

  test('default QrCode length is 12', async () => {
    const entity = define('simple_qr', {
      storage: Persistent(),
      schema: {
        code: QrCode(),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'simple_qr', 'create', {});
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.code as string).toHaveLength(12);
  });

  test('entities without Token/QrCode fields are unaffected', async () => {
    const entity = define('plain', {
      storage: Persistent(),
      schema: {
        title: Str(),
      },
    });
    const part = participate(entity);

    const { runtime } = await setup([entity], [part]);
    const res = await runtime.dispatch('system', 'plain', 'create', { title: 'hello' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    expect(data.title).toBe('hello');
  });
});

// ── parseDuration unit tests ────────────────────────────────────

describe('parseDuration()', () => {
  test('parses hours', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  test('parses days', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  test('parses compound expressions', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
  });

  test('parses numeric passthrough', () => {
    expect(parseDuration(60000)).toBe(60000);
  });

  test('throws on invalid format', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid duration');
  });
});

// ── Token expiry tests ──────────────────────────────────────────

describe('Token expiry companion field', () => {
  test('define() auto-injects _fieldExpiresAt for Token with expires', () => {
    const entity = define('api_key', {
      storage: Persistent(),
      schema: {
        label: Str(),
        secret: Token({ length: 24, expires: '24h' }),
      },
    });

    // The companion field should exist in the schema
    const schema = entity.record.schema;
    expect('_secretExpiresAt' in schema).toBe(true);
  });

  test('credential-generate computes expiry on create', async () => {
    registerHandlers();
    const entity = define('invite', {
      storage: Persistent(),
      schema: {
        email: Str(),
        token: Token({ prefix: 'inv_', length: 16, expires: '24h' }),
      },
    });
    const part = participate(entity);
    const compiled = compile([entity, part]);
    const mem = createMemoryAdapter();
    const store = createEntityStore({
      routing: compiled.persistRouting,
      adapters: { relational: mem, memory: mem },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: compiled, store });

    const before = Date.now();
    const res = await runtime.dispatch('system', 'invite', 'create', { email: 'a@b.com' });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    // Token should be generated
    expect(data.token).toBeDefined();
    expect((data.token as string).startsWith('inv_')).toBe(true);

    // Expiry should be ~24h from now
    expect(data._tokenExpiresAt).toBeDefined();
    const expiryTime = new Date(data._tokenExpiresAt as string).getTime();
    const expectedMin = before + 86_400_000 - 5000; // 5s tolerance
    const expectedMax = before + 86_400_000 + 5000;
    expect(expiryTime).toBeGreaterThan(expectedMin);
    expect(expiryTime).toBeLessThan(expectedMax);
  });

  test('no companion field when Token has no expires', () => {
    const entity = define('simple', {
      storage: Persistent(),
      schema: {
        key: Token({ length: 16 }),
      },
    });

    expect('_keyExpiresAt' in entity.record.schema).toBe(false);
  });
});
