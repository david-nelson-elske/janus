import { describe, expect, test } from 'bun:test';
import {
  Derived,
  isComputeDerived,
  isDerived,
  isPersistent,
  isSimpleDerived,
  isSingleton,
  isVirtual,
  isVolatile,
  minutes,
  Persistent,
  Singleton,
  Transitioned,
  Virtual,
  Volatile,
} from '..';

describe('Persistent', () => {
  test('no config', () => {
    const s = Persistent();
    expect(s.mode).toBe('persistent');
    expect(s.cache).toBeUndefined();
  });

  test('with cache', () => {
    const s = Persistent({ cache: { retain: minutes(5) } });
    expect(s.mode).toBe('persistent');
    expect(s.cache?.retain).toBe(minutes(5));
  });

  test('with cache invalidateOn', () => {
    const s = Persistent({ cache: { retain: minutes(5), invalidateOn: [Transitioned()] } });
    expect(s.cache?.invalidateOn).toHaveLength(1);
  });
});

describe('Singleton', () => {
  test('stores defaults', () => {
    const s = Singleton({ defaults: { maxNotes: 100, mode: 'draft' } });
    expect(s.mode).toBe('singleton');
    expect(s.defaults).toEqual({ maxNotes: 100, mode: 'draft' });
  });

  test('defaults are frozen', () => {
    const s = Singleton({ defaults: { key: 'val' } });
    expect(Object.isFrozen(s.defaults)).toBe(true);
  });
});

describe('Volatile', () => {
  test('stores retain duration', () => {
    const s = Volatile({ retain: minutes(5) });
    expect(s.mode).toBe('volatile');
    expect(s.retain).toBe(minutes(5));
  });
});

describe('Derived', () => {
  test('simple form — from + where', () => {
    const s = Derived({ from: 'event', where: { status: 'published' } });
    expect(s.mode).toBe('derived');
    expect(isSimpleDerived(s.config)).toBe(true);
    if (isSimpleDerived(s.config)) {
      expect(s.config.from).toBe('event');
      expect(s.config.where).toEqual({ status: 'published' });
    }
  });

  test('compute form', () => {
    const compute = async () => ({ records: [], total: 0 });
    const s = Derived({ compute });
    expect(s.mode).toBe('derived');
    expect(isComputeDerived(s.config)).toBe(true);
  });

  test('simple form with cache', () => {
    const s = Derived({
      from: 'note',
      where: { status: 'published' },
      cache: { retain: minutes(1) },
    });
    if (isSimpleDerived(s.config)) {
      expect(s.config.cache?.retain).toBe(minutes(1));
    }
  });
});

describe('Virtual', () => {
  test('stores provider', () => {
    const provider = {
      browse: async () => ({ records: [], total: 0 }),
      getById: async () => null,
    };
    const s = Virtual({ provider });
    expect(s.mode).toBe('virtual');
    expect(s.provider.browse).toBeDefined();
    expect(s.provider.getById).toBeDefined();
  });

  test('provider with optional create/update', () => {
    const provider = {
      browse: async () => ({ records: [], total: 0 }),
      getById: async () => null,
      create: async () => ({}),
    };
    const s = Virtual({ provider });
    expect(s.provider.create).toBeDefined();
    expect(s.provider.update).toBeUndefined();
  });
});

describe('type guards', () => {
  test('isPersistent', () => {
    expect(isPersistent(Persistent())).toBe(true);
    expect(isPersistent(Volatile({ retain: minutes(1) }))).toBe(false);
  });

  test('isSingleton', () => {
    expect(isSingleton(Singleton({ defaults: {} }))).toBe(true);
    expect(isSingleton(Persistent())).toBe(false);
  });

  test('isVolatile', () => {
    expect(isVolatile(Volatile({ retain: minutes(1) }))).toBe(true);
    expect(isVolatile(Persistent())).toBe(false);
  });

  test('isDerived', () => {
    expect(isDerived(Derived({ from: 'x', where: {} }))).toBe(true);
    expect(isDerived(Persistent())).toBe(false);
  });

  test('isVirtual', () => {
    const provider = { browse: async () => ({}), getById: async () => null };
    expect(isVirtual(Virtual({ provider }))).toBe(true);
    expect(isVirtual(Persistent())).toBe(false);
  });
});

describe('immutability', () => {
  test('all strategies are frozen', () => {
    expect(Object.isFrozen(Persistent())).toBe(true);
    expect(Object.isFrozen(Singleton({ defaults: {} }))).toBe(true);
    expect(Object.isFrozen(Volatile({ retain: minutes(1) }))).toBe(true);
    expect(Object.isFrozen(Derived({ from: 'x', where: {} }))).toBe(true);
  });
});
