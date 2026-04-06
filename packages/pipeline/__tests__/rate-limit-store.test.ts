/**
 * Focused unit tests for createRateLimitStore — sliding window counters.
 *
 * The rate-limit.test.ts file covers pipeline integration. This file
 * covers store-level edge cases: blocked increments, retryAfterMs
 * calculation, and window auto-reset.
 */

import { describe, expect, test } from 'bun:test';
import { createRateLimitStore } from '..';

describe('createRateLimitStore() — edge cases', () => {
  test('first check increments and returns count=1, blocked=false', () => {
    const store = createRateLimitStore();
    const result = store.check('key', 10, 60_000);
    expect(result.count).toBe(1);
    expect(result.blocked).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
  });

  test('checks up to max are not blocked', () => {
    const store = createRateLimitStore();
    for (let i = 1; i <= 5; i++) {
      const result = store.check('key', 5, 60_000);
      if (i < 5) {
        expect(result.blocked).toBe(false);
        expect(result.count).toBe(i);
      }
    }
  });

  test('check at max returns blocked=true with retryAfterMs', () => {
    const store = createRateLimitStore();
    // Fill to max
    store.check('key', 2, 60_000);
    store.check('key', 2, 60_000);

    // Next check should block
    const result = store.check('key', 2, 60_000);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(2);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs!).toBeGreaterThan(0);
    expect(result.retryAfterMs!).toBeLessThanOrEqual(60_000);
  });

  test('blocked check does not increment count', () => {
    const store = createRateLimitStore();
    store.check('key', 1, 60_000); // count = 1

    // These should all be blocked and not change the count
    store.check('key', 1, 60_000);
    store.check('key', 1, 60_000);

    expect(store.peek('key', 60_000)).toBe(1);
  });

  test('peek() returns count without incrementing', () => {
    const store = createRateLimitStore();
    store.check('key', 10, 60_000);
    store.check('key', 10, 60_000);

    expect(store.peek('key', 60_000)).toBe(2);
    expect(store.peek('key', 60_000)).toBe(2); // unchanged
  });

  test('peek() returns 0 for unknown key', () => {
    const store = createRateLimitStore();
    expect(store.peek('nonexistent', 60_000)).toBe(0);
  });

  test('clear() resets all counters', () => {
    const store = createRateLimitStore();
    store.check('a', 10, 60_000);
    store.check('b', 10, 60_000);
    store.check('c', 10, 60_000);

    store.clear();

    expect(store.peek('a', 60_000)).toBe(0);
    expect(store.peek('b', 60_000)).toBe(0);
    expect(store.peek('c', 60_000)).toBe(0);
  });

  test('window auto-resets after windowMs elapses', () => {
    const store = createRateLimitStore();
    // Use a 1ms window
    store.check('key', 2, 1);
    store.check('key', 2, 1);

    // Busy-wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const result = store.check('key', 2, 1);
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(1);
  });

  test('retryAfterMs calculation is correct (windowMs - elapsed)', () => {
    const store = createRateLimitStore();
    const windowMs = 10_000;

    // Fill to max
    store.check('key', 1, windowMs);

    // Small busy-wait to make elapsed measurable
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }

    const result = store.check('key', 1, windowMs);
    expect(result.blocked).toBe(true);
    // retryAfterMs should be less than windowMs (some time has elapsed)
    expect(result.retryAfterMs!).toBeLessThan(windowMs);
    expect(result.retryAfterMs!).toBeGreaterThan(0);
  });
});
