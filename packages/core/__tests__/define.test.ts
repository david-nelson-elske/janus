import { describe, expect, test } from 'bun:test';
import { define, deriveOperations } from '..';
import {
  Str,
  Int,
  Markdown,
  DateTime,
  Lifecycle,
  Relation,
  Reference,
  Mention,
  Persistent,
  Singleton,
  Volatile,
  Derived,
  Virtual,
  Public,
  Sensitive,
  Enum,
  hours,
} from '@janus/vocabulary';

describe('define()', () => {
  // ── Basic behavior ──────────────────────────────────────────

  test('returns frozen DefineResult with kind: define', () => {
    const result = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    expect(result.kind).toBe('define');
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('record is deeply frozen', () => {
    const result = define('note', {
      schema: { title: Str() },
      storage: Persistent(),
    });
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.operations)).toBe(true);
    expect(Object.isFrozen(result.record.lifecycles)).toBe(true);
    expect(Object.isFrozen(result.record.wiringFields)).toBe(true);
    expect(Object.isFrozen(result.record.transitionTargets)).toBe(true);
  });

  test('multiple define() calls produce independent records', () => {
    const a = define('alpha', { schema: { x: Str() }, storage: Persistent() });
    const b = define('beta', { schema: { y: Int() }, storage: Volatile({ retain: hours(24) }) });
    expect(a.record.name).toBe('alpha');
    expect(b.record.name).toBe('beta');
    expect(a.record.operations).not.toBe(b.record.operations);
  });

  test('description is optional', () => {
    const result = define('note', { schema: { title: Str() }, storage: Persistent() });
    expect(result.record.description).toBeUndefined();
  });

  test('description is preserved', () => {
    const result = define('note', {
      schema: { title: Str() },
      storage: Persistent(),
      description: 'A note entity',
    });
    expect(result.record.description).toBe('A note entity');
  });

  test('origin is consumer', () => {
    const result = define('note', { schema: { title: Str() }, storage: Persistent() });
    expect(result.record.origin).toBe('consumer');
  });

  // ── Name validation ─────────────────────────────────────────

  test('rejects empty name', () => {
    expect(() => define('', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects hyphens', () => {
    expect(() => define('my-entity', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects colons', () => {
    expect(() => define('audit:records', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects uppercase', () => {
    expect(() => define('MyEntity', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects leading underscore', () => {
    expect(() => define('_private', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects trailing underscore', () => {
    expect(() => define('private_', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects consecutive underscores', () => {
    expect(() => define('my__entity', { schema: {}, storage: Persistent() })).toThrow();
  });

  test('rejects name longer than 64 chars', () => {
    const longName = 'a'.repeat(65);
    expect(() => define(longName, { schema: {}, storage: Persistent() })).toThrow();
  });

  // ── Reserved field names ─────────────────────────────────────

  test('rejects reserved field name: createdAt', () => {
    expect(() => define('note', {
      schema: { createdAt: Str() },
      storage: Persistent(),
    })).toThrow('Reserved field name');
  });

  test('rejects reserved field name: _version', () => {
    expect(() => define('note', {
      schema: { _version: Int() },
      storage: Persistent(),
    })).toThrow('Reserved field name');
  });

  test('rejects reserved field name: id', () => {
    expect(() => define('note', {
      schema: { id: Str() },
      storage: Persistent(),
    })).toThrow('Reserved field name');
  });

  test('allows non-reserved field names', () => {
    expect(() => define('note', {
      schema: { title: Str(), created_date: Str() },
      storage: Persistent(),
    })).not.toThrow();
  });

  test('accepts valid names', () => {
    expect(() => define('note', { schema: {}, storage: Persistent() })).not.toThrow();
    expect(() => define('task', { schema: {}, storage: Persistent() })).not.toThrow();
    expect(() => define('test_run', { schema: {}, storage: Persistent() })).not.toThrow();
    expect(() => define('connector_binding', { schema: {}, storage: Persistent() })).not.toThrow();
    expect(() => define('a1b2c3', { schema: {}, storage: Persistent() })).not.toThrow();
  });

  test('accepts name with exactly 64 chars', () => {
    const name = 'a'.repeat(64);
    expect(() => define(name, { schema: {}, storage: Persistent() })).not.toThrow();
  });

  // ── Operations by storage ───────────────────────────────────

  test('Persistent → read, create, update, delete', () => {
    const r = define('a', { schema: {}, storage: Persistent() });
    expect(r.record.operations).toEqual(['read', 'create', 'update', 'delete']);
  });

  test('Singleton → read, update', () => {
    const r = define('a', { schema: {}, storage: Singleton({ defaults: {} }) });
    expect(r.record.operations).toEqual(['read', 'update']);
  });

  test('Volatile → read, create, update, delete', () => {
    const r = define('a', { schema: {}, storage: Volatile({ retain: hours(24) }) });
    expect(r.record.operations).toEqual(['read', 'create', 'update', 'delete']);
  });

  test('Derived → read', () => {
    const r = define('a', {
      schema: {},
      storage: Derived({ from: 'note', where: {} }),
    });
    expect(r.record.operations).toEqual(['read']);
  });

  test('Virtual → read', () => {
    const r = define('a', {
      schema: {},
      storage: Virtual({
        provider: {
          browse: async () => ({ records: [], total: 0 }),
          getById: async () => null,
        },
      }),
    });
    expect(r.record.operations).toEqual(['read']);
  });

  // ── Schema scanning ─────────────────────────────────────────

  test('Lifecycle field produces lifecycles entry', () => {
    const r = define('note', {
      schema: {
        status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      },
      storage: Persistent(),
    });
    expect(r.record.lifecycles).toHaveLength(1);
    expect(r.record.lifecycles[0].field).toBe('status');
    expect(r.record.lifecycles[0].lifecycle.initial).toBe('draft');
  });

  test('Relation field produces wiringFields entry', () => {
    const r = define('note', {
      schema: { author: Relation('user') },
      storage: Persistent(),
    });
    expect(r.record.wiringFields).toHaveLength(1);
    expect(r.record.wiringFields[0].field).toBe('author');
  });

  test('Reference field produces wiringFields entry', () => {
    const r = define('note', {
      schema: { related: Reference('venue') },
      storage: Persistent(),
    });
    expect(r.record.wiringFields).toHaveLength(1);
    expect(r.record.wiringFields[0].field).toBe('related');
  });

  test('Mention field produces wiringFields entry', () => {
    const r = define('note', {
      schema: { mentioned: Mention({ allowed: ['user', 'venue'] }) },
      storage: Persistent(),
    });
    expect(r.record.wiringFields).toHaveLength(1);
    expect(r.record.wiringFields[0].field).toBe('mentioned');
  });

  test('non-lifecycle non-wiring fields produce neither', () => {
    const r = define('note', {
      schema: { title: Str(), count: Int() },
      storage: Persistent(),
    });
    expect(r.record.lifecycles).toHaveLength(0);
    expect(r.record.wiringFields).toHaveLength(0);
  });

  // ── Owned flag ──────────────────────────────────────────────

  test('owned defaults to undefined', () => {
    const r = define('note', { schema: { title: Str() }, storage: Persistent() });
    expect(r.record.owned).toBeUndefined();
  });

  test('owned: true is preserved', () => {
    const r = define('registration', {
      schema: { notes: Str() },
      storage: Persistent(),
      owned: true,
    });
    expect(r.record.owned).toBe(true);
  });

  // ── Transition targets ──────────────────────────────────────

  test('transition targets derived from lifecycle', () => {
    const r = define('note', {
      schema: {
        status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      },
      storage: Persistent(),
    });
    expect(r.record.transitionTargets).toEqual([
      { field: 'status', from: 'draft', to: 'published', name: 'published' },
      { field: 'status', from: 'published', to: 'archived', name: 'archived' },
    ]);
  });

  test('duplicate transition target names across lifecycles throw', () => {
    expect(() =>
      define('note', {
        schema: {
          status: Lifecycle({ draft: ['published'] }),
          review: Lifecycle({ pending: ['published'] }),
        },
        storage: Persistent(),
      }),
    ).toThrow('Duplicate transition target');
  });

  // ── Classification ──────────────────────────────────────────

  test('bare schema wrapped with Private()', () => {
    const r = define('note', {
      schema: { title: Str() },
      storage: Persistent(),
    });
    expect(r.record.classifiedSchema.classification.kind).toBe('private');
    expect(r.record.sensitivity).toBe('standard');
  });

  test('Public schema preserves classification', () => {
    const r = define('note', {
      schema: Public({ title: Str() }),
      storage: Persistent(),
    });
    expect(r.record.classifiedSchema.classification.kind).toBe('public');
    expect(r.record.sensitivity).toBe('open');
  });

  test('Sensitive schema derives restricted sensitivity', () => {
    const r = define('payment', {
      schema: Sensitive({ card: Str() }),
      storage: Persistent(),
    });
    expect(r.record.classifiedSchema.classification.kind).toBe('sensitive');
    expect(r.record.sensitivity).toBe('restricted');
  });
});

describe('deriveOperations()', () => {
  test('Persistent → full CRUD', () => {
    expect(deriveOperations(Persistent())).toEqual(['read', 'create', 'update', 'delete']);
  });

  test('Singleton → read + update', () => {
    expect(deriveOperations(Singleton({ defaults: {} }))).toEqual(['read', 'update']);
  });

  test('Derived → read only', () => {
    expect(deriveOperations(Derived({ from: 'x', where: {} }))).toEqual(['read']);
  });

  test('Virtual → read only', () => {
    expect(
      deriveOperations(
        Virtual({ provider: { browse: async () => ({ records: [], total: 0 }), getById: async () => null } }),
      ),
    ).toEqual(['read']);
  });

  test('Volatile → full CRUD', () => {
    expect(deriveOperations(Volatile({ retain: hours(24) }))).toEqual(['read', 'create', 'update', 'delete']);
  });
});
