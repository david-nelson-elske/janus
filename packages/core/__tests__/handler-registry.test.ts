import { afterEach, describe, expect, test } from 'bun:test';
import {
  handler,
  resolveHandler,
  getRegistry,
  clearRegistry,
  seedHandlers,
  FRAMEWORK_HANDLERS,
} from '..';

afterEach(() => {
  clearRegistry();
});

describe('handler()', () => {
  test('registers and returns key', () => {
    const key = handler('test-handler', async () => {}, 'A test handler');
    expect(key).toBe('test-handler');
  });

  test('throws on duplicate key', () => {
    handler('dup', async () => {}, 'first');
    expect(() => handler('dup', async () => {}, 'second')).toThrow("Handler 'dup' is already registered");
  });
});

describe('resolveHandler()', () => {
  test('returns registered entry', () => {
    const fn = async () => {};
    handler('resolve-test', fn, 'desc');
    const entry = resolveHandler('resolve-test');
    expect(entry).toBeDefined();
    expect(entry!.fn).toBe(fn);
    expect(entry!.description).toBe('desc');
  });

  test('returns undefined for unknown key', () => {
    expect(resolveHandler('nonexistent')).toBeUndefined();
  });
});

describe('getRegistry()', () => {
  test('returns map with registered handlers', () => {
    handler('a', async () => {}, 'A');
    handler('b', async () => {}, 'B');
    const reg = getRegistry();
    expect(reg.size).toBe(2);
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(true);
  });
});

describe('clearRegistry()', () => {
  test('removes all handlers', () => {
    handler('a', async () => {}, 'A');
    expect(getRegistry().size).toBe(1);
    clearRegistry();
    expect(getRegistry().size).toBe(0);
  });
});

describe('seedHandlers()', () => {
  test('registers all framework handlers', () => {
    seedHandlers();
    const reg = getRegistry();
    expect(reg.size).toBe(FRAMEWORK_HANDLERS.length);
  });

  test('includes all expected handler keys', () => {
    seedHandlers();
    const reg = getRegistry();
    const expected = [
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
    ];
    for (const key of expected) {
      expect(reg.has(key)).toBe(true);
    }
  });

  test('all handlers have descriptions', () => {
    seedHandlers();
    for (const [, entry] of getRegistry()) {
      expect(entry.description).toBeTruthy();
    }
  });

  test('is idempotent (does not throw on re-call)', () => {
    seedHandlers();
    expect(() => seedHandlers()).not.toThrow();
  });
});
