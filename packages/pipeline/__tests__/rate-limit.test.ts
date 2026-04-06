/**
 * Tests for rate-limit-check handler and rate limit store.
 *
 * Exercises: in-memory counter, window expiry, per-identity keys,
 * pipeline integration via participate({ rateLimit }).
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
  createBroker,
  frameworkEntities,
  frameworkParticipations,
  createRateLimitStore,
  getRateLimitStore,
} from '..';
import type { DispatchRuntime } from '..';
import { Str, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Rate limit store unit tests ────────────────────────────────

describe('createRateLimitStore()', () => {
  test('first check returns count 1, not blocked', () => {
    const store = createRateLimitStore();
    const result = store.check('key', 10, 60_000);
    expect(result.count).toBe(1);
    expect(result.blocked).toBe(false);
  });

  test('blocks after max is reached', () => {
    const store = createRateLimitStore();
    for (let i = 0; i < 3; i++) {
      store.check('key', 3, 60_000);
    }
    const result = store.check('key', 3, 60_000);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(3);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('different keys are independent', () => {
    const store = createRateLimitStore();
    store.check('a', 1, 60_000);
    const result = store.check('b', 1, 60_000);
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(1);
  });

  test('window expiry resets counter', () => {
    const store = createRateLimitStore();
    // Fill the counter
    store.check('key', 2, 1); // 1ms window
    store.check('key', 2, 1);

    // Wait for window to expire (use a synchronous busy-wait to avoid flakes)
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const result = store.check('key', 2, 1);
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(1);
  });

  test('peek returns count without incrementing', () => {
    const store = createRateLimitStore();
    store.check('key', 10, 60_000);
    store.check('key', 10, 60_000);
    expect(store.peek('key', 60_000)).toBe(2);

    // Peek again — count unchanged
    expect(store.peek('key', 60_000)).toBe(2);
  });

  test('peek returns 0 for unknown key', () => {
    const store = createRateLimitStore();
    expect(store.peek('unknown', 60_000)).toBe(0);
  });

  test('clear resets all counters', () => {
    const store = createRateLimitStore();
    store.check('a', 10, 60_000);
    store.check('b', 10, 60_000);
    store.clear();
    expect(store.peek('a', 60_000)).toBe(0);
    expect(store.peek('b', 60_000)).toBe(0);
  });
});

// ── Pipeline integration ───────────────────────────────────────

describe('rate-limit-check pipeline integration', () => {
  function setup(rateLimit: { max: number; window: number }) {
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });

    const registry = compile([
      note,
      participate(note, { rateLimit }),
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });

    return { registry, store };
  }

  test('allows requests under the limit', async () => {
    const { registry, store } = setup({ max: 5, window: 60_000 });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    const resp = await runtime.dispatch('system', 'note', 'create', { title: 'Test' }, SYSTEM);
    expect(resp.ok).toBe(true);
  });

  test('blocks requests that exceed the limit', async () => {
    const { registry, store } = setup({ max: 2, window: 60_000 });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    const alice = { id: 'alice', roles: ['user'] };

    // Two creates should succeed
    const r1 = await runtime.dispatch('system', 'note', 'create', { title: 'Note 1' }, alice);
    expect(r1.ok).toBe(true);
    const r2 = await runtime.dispatch('system', 'note', 'create', { title: 'Note 2' }, alice);
    expect(r2.ok).toBe(true);

    // Third should be rate-limited
    const r3 = await runtime.dispatch('system', 'note', 'create', { title: 'Note 3' }, alice);
    expect(r3.ok).toBe(false);
    expect(r3.error?.kind).toBe('rate-limit-exceeded');
    expect(r3.error?.retryable).toBe(true);
  });

  test('different identities have independent limits', async () => {
    const { registry, store } = setup({ max: 1, window: 60_000 });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    const alice = { id: 'alice', roles: ['user'] };
    const bob = { id: 'bob', roles: ['user'] };

    const r1 = await runtime.dispatch('system', 'note', 'create', { title: 'Alice' }, alice);
    expect(r1.ok).toBe(true);

    // Alice is now limited, but Bob should still be fine
    const r2 = await runtime.dispatch('system', 'note', 'create', { title: 'Bob' }, bob);
    expect(r2.ok).toBe(true);

    // Alice is blocked
    const r3 = await runtime.dispatch('system', 'note', 'create', { title: 'Alice again' }, alice);
    expect(r3.ok).toBe(false);
    expect(r3.error?.kind).toBe('rate-limit-exceeded');
  });

  test('rate limit store resets on registerHandlers()', () => {
    registerHandlers();
    const store = getRateLimitStore();
    store.check('test', 1, 60_000);
    expect(store.peek('test', 60_000)).toBe(1);

    // Re-register clears the store
    registerHandlers();
    const newStore = getRateLimitStore();
    expect(newStore.peek('test', 60_000)).toBe(0);
  });

  test('entity without rateLimit config is not rate-limited', async () => {
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });

    const registry = compile([
      note,
      participate(note, {}), // no rateLimit
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // Many operations should all succeed (no limit)
    for (let i = 0; i < 10; i++) {
      const resp = await runtime.dispatch('system', 'note', 'create', { title: `Note ${i}` }, SYSTEM);
      expect(resp.ok).toBe(true);
    }
  });
});
