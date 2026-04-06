import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, seedHandlers, clearRegistry } from '..';
import { Str, Lifecycle, Relation, Reference, Mention, Persistent } from '@janus/vocabulary';
import type { WiringEffects } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Helpers ─────────────────────────────────────────────────────

function seedAndCompile(...defs: Parameters<typeof compile>[0]) {
  seedHandlers();
  return compile(defs);
}

// ── Effects resolution on WiringEdge ────────────────────────────

describe('wiring effects on WiringEdge', () => {
  test('Relation() backward compat: cascade maps to effects.deleted', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: { title: Str(), author: Relation('user', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const edge = result.wiring.edges.find((e) => e.from === 'note' && e.fromField === 'author');
    expect(edge).toBeDefined();
    expect(edge!.effects?.deleted).toBe('cascade');
  });

  test('Relation() default: restrict when no config', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: { title: Str(), author: Relation('user') },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const edge = result.wiring.edges.find((e) => e.from === 'note' && e.fromField === 'author');
    expect(edge!.effects?.deleted).toBe('restrict');
  });

  test('Relation() with explicit effects config', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', {
          effects: {
            deleted: 'nullify',
            transitioned: { archived: 'cascade' },
          },
        }),
      },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const edge = result.wiring.edges.find((e) => e.from === 'note' && e.fromField === 'author');
    expect(edge!.effects?.deleted).toBe('nullify');
    expect(edge!.effects?.transitioned?.archived).toBe('cascade');
  });

  test('Reference() with effects config', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        reviewer: Reference('user', { effects: { deleted: 'nullify' } }),
      },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const edge = result.wiring.edges.find((e) => e.from === 'note' && e.fromField === 'reviewer');
    expect(edge!.effects?.deleted).toBe('nullify');
  });

  test('Reference() without effects has no effects on edge', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: { title: Str(), reviewer: Reference('user') },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const edge = result.wiring.edges.find((e) => e.from === 'note' && e.fromField === 'reviewer');
    expect(edge!.effects).toBeUndefined();
  });

  test('conflicting cascade and effects.deleted throws', () => {
    expect(() =>
      Relation('user', { cascade: 'cascade', effects: { deleted: 'nullify' } }),
    ).toThrow(/Conflicting effect config/);
  });
});

// ── reverseEffects() helper ─────────────────────────────────────

describe('reverseEffects()', () => {
  test('returns inbound edges with effects for the target entity', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', { cascade: 'cascade' }),
        reviewer: Reference('user', { effects: { deleted: 'nullify' } }),
      },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    const effects = result.wiring.reverseEffects('user');
    expect(effects).toHaveLength(2);
    expect(effects.some((e) => e.fromField === 'author' && e.effects?.deleted === 'cascade')).toBe(true);
    expect(effects.some((e) => e.fromField === 'reviewer' && e.effects?.deleted === 'nullify')).toBe(true);
  });

  test('returns empty for entity with no inbound effects', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: { title: Str(), reviewer: Reference('user') },
      storage: Persistent(),
    });
    const result = seedAndCompile(user, note, participate(user, {}), participate(note, {}));

    // Reference without effects -> not in reverseEffects
    expect(result.wiring.reverseEffects('user')).toHaveLength(0);
  });
});

// ── Circular cascade detection ──────────────────────────────────

describe('circular cascade detection', () => {
  test('direct circular cascade throws at compile time', () => {
    const a = define('entity_a', {
      schema: { ref: Relation('entity_b', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const b = define('entity_b', {
      schema: { ref: Relation('entity_a', { cascade: 'cascade' }) },
      storage: Persistent(),
    });

    seedHandlers();
    expect(() =>
      compile([a, b, participate(a, {}), participate(b, {})]),
    ).toThrow(/Circular cascade/);
  });

  test('non-cascade circular references are OK', () => {
    const a = define('entity_a', {
      schema: { ref: Relation('entity_b', { cascade: 'restrict' }) },
      storage: Persistent(),
    });
    const b = define('entity_b', {
      schema: { ref: Relation('entity_a', { cascade: 'restrict' }) },
      storage: Persistent(),
    });

    seedHandlers();
    // Should not throw — restrict doesn't cascade
    const result = compile([a, b, participate(a, {}), participate(b, {})]);
    expect(result.graphNodes.size).toBe(2);
  });

  test('indirect circular cascade (A->B->C->A) throws', () => {
    const a = define('entity_a', {
      schema: { ref: Relation('entity_b', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const b = define('entity_b', {
      schema: { ref: Relation('entity_c', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const c = define('entity_c', {
      schema: { ref: Relation('entity_a', { cascade: 'cascade' }) },
      storage: Persistent(),
    });

    seedHandlers();
    expect(() =>
      compile([a, b, c, participate(a, {}), participate(b, {}), participate(c, {})]),
    ).toThrow(/Circular cascade/);
  });
});

// ── Transition effect validation ───────────────────────────────

describe('transition effect compile-time validation', () => {
  test('{ transition } on entity without lifecycle throws InvalidEffectTargetError', () => {
    // note has no lifecycle, so { transition: 'cancelled' } is invalid
    const venue = define('venue', {
      schema: {
        name: Str(),
        status: Lifecycle({ active: ['archived'] }),
      },
      storage: Persistent(),
    });
    const note = define('note', {
      schema: {
        title: Str(),
        venue: Relation('venue', {
          effects: { transitioned: { archived: { transition: 'cancelled' } } },
        }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    expect(() =>
      compile([venue, note, participate(venue, {}), participate(note, {})]),
    ).toThrow(/requires entity 'note' to have a lifecycle field/);
  });

  test('{ transition } to unreachable state throws UnreachableTransitionEffectError', () => {
    const venue = define('venue', {
      schema: {
        name: Str(),
        status: Lifecycle({ active: ['archived'] }),
      },
      storage: Persistent(),
    });
    const event_entity = define('event_entity', {
      schema: {
        title: Str(),
        phase: Lifecycle({ draft: ['published'], published: ['archived'] }),
        venue: Relation('venue', {
          effects: { transitioned: { archived: { transition: 'nonexistent_state' } } },
        }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    expect(() =>
      compile([venue, event_entity, participate(venue, {}), participate(event_entity, {})]),
    ).toThrow(/state 'nonexistent_state' is not a valid transition target/);
  });

  test('{ transition } to reachable state compiles OK', () => {
    const venue = define('venue', {
      schema: {
        name: Str(),
        status: Lifecycle({ active: ['archived'] }),
      },
      storage: Persistent(),
    });
    const event_entity = define('event_entity', {
      schema: {
        title: Str(),
        phase: Lifecycle({ draft: ['published', 'cancelled'], published: ['cancelled'] }),
        venue: Relation('venue', {
          effects: { transitioned: { archived: { transition: 'cancelled' } } },
        }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    const result = compile([venue, event_entity, participate(venue, {}), participate(event_entity, {})]);
    expect(result.graphNodes.size).toBe(2);
  });

  test('string transition actions (nullify, cascade) skip lifecycle validation', () => {
    // nullify/cascade don't need lifecycle — they delete or null-out the field
    const user = define('user', {
      schema: {
        name: Str(),
        status: Lifecycle({ active: ['archived'] }),
      },
      storage: Persistent(),
    });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', {
          effects: { transitioned: { archived: 'nullify' } },
        }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    // Should not throw — nullify doesn't require lifecycle on note
    const result = compile([user, note, participate(user, {}), participate(note, {})]);
    expect(result.graphNodes.size).toBe(2);
  });
});

// ── Conflicting effects validation ─────────────────────────────

describe('conflicting effects validation', () => {
  test('restrict + cascade on same target throws ConflictingEffectError', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', { cascade: 'restrict' }),
      },
      storage: Persistent(),
    });
    const comment = define('comment', {
      schema: {
        body: Str(),
        author: Relation('user', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    expect(() =>
      compile([user, note, comment, participate(user, {}), participate(note, {}), participate(comment, {})]),
    ).toThrow(/Conflicting delete effects on entity 'user'/);
  });

  test('restrict + nullify on same target is OK', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', { cascade: 'restrict' }),
      },
      storage: Persistent(),
    });
    const comment = define('comment', {
      schema: {
        body: Str(),
        author: Relation('user', { cascade: 'nullify' }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    // restrict + nullify is fine — nullify clears the field, restrict blocks only if records exist
    const result = compile([user, note, comment, participate(user, {}), participate(note, {}), participate(comment, {})]);
    expect(result.graphNodes.size).toBe(3);
  });

  test('cascade + nullify on same target is OK', () => {
    const user = define('user', { schema: { name: Str() }, storage: Persistent() });
    const note = define('note', {
      schema: {
        title: Str(),
        author: Relation('user', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });
    const comment = define('comment', {
      schema: {
        body: Str(),
        author: Relation('user', { cascade: 'nullify' }),
      },
      storage: Persistent(),
    });

    seedHandlers();
    const result = compile([user, note, comment, participate(user, {}), participate(note, {}), participate(comment, {})]);
    expect(result.graphNodes.size).toBe(3);
  });
});
