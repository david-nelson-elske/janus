/**
 * Unit tests for registerHandlers — real handler registration.
 *
 * Exercises: handler registration, resolution, rate limit store,
 * and FRAMEWORK_HANDLERS coverage.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerHandlers, getRateLimitStore } from '..';
import { clearRegistry, resolveHandler, FRAMEWORK_HANDLERS } from '@janus/core';

afterEach(() => {
  clearRegistry();
});

describe('registerHandlers()', () => {
  test('after registerHandlers(), all FRAMEWORK_HANDLERS have registered functions', () => {
    registerHandlers();

    for (const { key } of FRAMEWORK_HANDLERS) {
      const entry = resolveHandler(key);
      expect(entry).toBeDefined();
      expect(typeof entry!.fn).toBe('function');
    }
  });

  test('resolveHandler("schema-parse") returns non-null', () => {
    registerHandlers();
    const entry = resolveHandler('schema-parse');
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/parse|pars/i);
  });

  test('resolveHandler("store-read") returns non-null', () => {
    registerHandlers();
    const entry = resolveHandler('store-read');
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/read/i);
  });

  test('getRateLimitStore() returns a rate limit store', () => {
    registerHandlers();
    const store = getRateLimitStore();
    expect(store).toBeDefined();
    expect(typeof store.check).toBe('function');
    expect(typeof store.peek).toBe('function');
    expect(typeof store.clear).toBe('function');
  });

  test('calling registerHandlers() again resets the rate limit store', () => {
    registerHandlers();
    const store1 = getRateLimitStore();
    store1.check('test-key', 10, 60_000);
    expect(store1.peek('test-key', 60_000)).toBe(1);

    registerHandlers();
    const store2 = getRateLimitStore();
    expect(store2.peek('test-key', 60_000)).toBe(0);
    expect(store2).not.toBe(store1);
  });

  test('each handler key resolves to a function', () => {
    registerHandlers();

    const expectedKeys = [
      'policy-lookup',
      'rate-limit-check',
      'schema-parse',
      'schema-validate',
      'invariant-check',
      'store-read',
      'store-create',
      'store-update',
      'store-delete',
      'emit-broker',
      'audit-relational',
      'audit-memory',
      'observe-memory',
      'respond-shaper',
      'dispatch-adapter',
      'http-receive',
      'http-identity',
      'http-respond',
      'agent-receive',
      'agent-identity',
      'agent-respond',
      'connector-distribute',
    ];

    for (const key of expectedKeys) {
      const entry = resolveHandler(key);
      expect(entry).toBeDefined();
      expect(typeof entry!.fn).toBe('function');
    }
  });
});
