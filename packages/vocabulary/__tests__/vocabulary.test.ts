import { describe, expect, test } from 'bun:test';
import {
  Act,
  // Audit levels
  AuditFull,
  AuditLight,
  AuditNone,
  // Operations
  Browse,
  Create,
  // Event descriptors (for invariant test)
  Created,
  DateTime,
  Delete,
  days,
  defineLifecycle,
  Enum,
  Get,
  GetById,
  hours,
  Int,
  // Invariants
  Invariant,
  isActOp,
  isLifecycle,
  isTransitionOp,
  // Lifecycles
  Lifecycle,
  Markdown,
  minutes,
  Private,
  // Classifications
  Public,
  parseDuration,
  Relation,
  Sensitive,
  // Semantic types (for classification test)
  Str,
  // Duration
  seconds,
  Transition,
  Update,
  weeks,
} from '..';

// ── Duration ─────────────────────────────────────────────────────

describe('duration', () => {
  test('named constructors produce correct milliseconds', () => {
    expect(seconds(1) as number).toBe(1_000);
    expect(minutes(1) as number).toBe(60_000);
    expect(hours(1) as number).toBe(3_600_000);
    expect(days(1) as number).toBe(86_400_000);
    expect(weeks(1) as number).toBe(604_800_000);
  });

  test('parseDuration handles single units', () => {
    expect(parseDuration('5m') as number).toBe(300_000);
    expect(parseDuration('2h') as number).toBe(7_200_000);
    expect(parseDuration('90d') as number).toBe(90 * 86_400_000);
  });

  test('parseDuration handles compound expressions', () => {
    expect(parseDuration('1h30m') as number).toBe(3_600_000 + 1_800_000);
  });

  test('parseDuration handles numeric input', () => {
    expect(parseDuration(5000) as number).toBe(5000);
  });

  test('parseDuration throws on invalid input', () => {
    expect(() => parseDuration('abc')).toThrow();
  });
});

// ── Lifecycle ────────────────────────────────────────────────────

describe('Lifecycle', () => {
  test('basic lifecycle', () => {
    const lc = Lifecycle({ draft: ['published'], published: ['archived'] });
    expect(lc.kind).toBe('lifecycle');
    expect(lc.initial).toBe('draft');
    expect(lc.states).toContain('draft');
    expect(lc.states).toContain('published');
    expect(lc.states).toContain('archived');
    expect(lc.terminalStates).toEqual(['archived']);
  });

  test('initial is first key', () => {
    const lc = Lifecycle({ pending: ['active'], active: ['closed'] });
    expect(lc.initial).toBe('pending');
  });

  test('terminal states have no outgoing transitions', () => {
    const lc = Lifecycle({
      draft: ['published', 'rejected'],
      published: ['archived'],
    });
    expect(lc.terminalStates).toContain('rejected');
    expect(lc.terminalStates).toContain('archived');
    expect(lc.terminalStates).not.toContain('draft');
    expect(lc.terminalStates).not.toContain('published');
  });

  test('lifecycle is frozen', () => {
    const lc = Lifecycle({ draft: ['published'] });
    expect(Object.isFrozen(lc)).toBe(true);
  });

  test('empty lifecycle throws', () => {
    expect(() => Lifecycle({})).toThrow();
  });
});

describe('defineLifecycle', () => {
  test('named lifecycle has name', () => {
    const lc = defineLifecycle('publish', { draft: ['published'], published: ['archived'] });
    expect(lc.name).toBe('publish');
    expect(lc.kind).toBe('lifecycle');
    expect(lc.initial).toBe('draft');
  });
});

describe('isLifecycle', () => {
  test('true for lifecycle', () => {
    expect(isLifecycle(Lifecycle({ a: ['b'] }))).toBe(true);
  });

  test('false for non-lifecycle', () => {
    expect(isLifecycle(Str())).toBe(false);
    expect(isLifecycle(null)).toBe(false);
  });
});

// ── Operations ───────────────────────────────────────────────────

describe('operations', () => {
  test('singleton constants have correct kinds', () => {
    expect(Browse.kind).toBe('browse');
    expect(Get.kind).toBe('get');
    expect(GetById.kind).toBe('getById');
    expect(Create.kind).toBe('create');
    expect(Update.kind).toBe('update');
    expect(Delete.kind).toBe('delete');
  });

  test('singletons are frozen', () => {
    expect(Object.isFrozen(Browse)).toBe(true);
    expect(Object.isFrozen(Create)).toBe(true);
  });

  test('Transition stores operation name', () => {
    const op = Transition('publish');
    expect(op.kind).toBe('transition');
    expect((op as { operation: string }).operation).toBe('publish');
  });

  test('Act stores action name', () => {
    const op = Act('cancel');
    expect(op.kind).toBe('act');
    expect((op as { name: string }).name).toBe('cancel');
  });

  test('type guards', () => {
    expect(isTransitionOp(Transition('publish'))).toBe(true);
    expect(isTransitionOp(Browse)).toBe(false);
    expect(isActOp(Act('cancel'))).toBe(true);
    expect(isActOp(Browse)).toBe(false);
  });
});

// ── Classifications ──────────────────────────────────────────────

describe('classifications', () => {
  test('Public wraps schema with public classification', () => {
    const cs = Public({ title: Str(), startsAt: DateTime() });
    expect(cs.classification.kind).toBe('public');
    expect(cs.schema.title).toBeDefined();
    expect(cs.schema.startsAt).toBeDefined();
  });

  test('Private wraps schema', () => {
    const cs = Private({ amount: Int() });
    expect(cs.classification.kind).toBe('private');
  });

  test('Sensitive wraps schema', () => {
    const cs = Sensitive({ ssn: Str() });
    expect(cs.classification.kind).toBe('sensitive');
  });

  test('schema is frozen', () => {
    const cs = Public({ title: Str() });
    expect(Object.isFrozen(cs.schema)).toBe(true);
  });
});

// ── Audit levels ─────────────────────────────────────────────────

describe('audit levels', () => {
  test('singletons have correct kinds', () => {
    expect(AuditFull.kind).toBe('full');
    expect(AuditLight.kind).toBe('light');
    expect(AuditNone.kind).toBe('none');
  });

  test('singletons are frozen', () => {
    expect(Object.isFrozen(AuditFull)).toBe(true);
  });
});

// ── Invariants ───────────────────────────────────────────────────

describe('invariants', () => {
  test('basic invariant', () => {
    const inv = Invariant('end after start', (r) => !r.endsAt || r.endsAt > r.startsAt);
    expect(inv.kind).toBe('invariant');
    expect(inv.name).toBe('end after start');
    expect(inv.severity).toBe('error');
    expect(inv.on).toHaveLength(4); // Created, Updated, Deleted, Transitioned()
  });

  test('invariant with custom on', () => {
    const inv = Invariant('check on create only', () => true, { on: [Created] });
    expect(inv.on).toHaveLength(1);
  });

  test('invariant with warn severity', () => {
    const inv = Invariant('soft check', () => true, { severity: 'warn' });
    expect(inv.severity).toBe('warn');
  });

  test('invariant predicate is callable', () => {
    const inv = Invariant('always true', () => true);
    expect(inv.predicate({}, {})).toBe(true);
  });
});

// ── Integration: Note proof entity shape ─────────────────────────

describe('Note proof entity (vocabulary only)', () => {
  test('Note schema can be expressed with vocabulary', () => {
    const schema = Private({
      title: Str({ required: true, as: 'title' }),
      body: Markdown(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      author: Relation('user'),
    });

    expect(schema.classification.kind).toBe('private');
    expect((schema.schema.title as { kind: string }).kind).toBe('str');
    expect((schema.schema.body as { kind: string }).kind).toBe('markdown');
    expect((schema.schema.status as { kind: string }).kind).toBe('lifecycle');
    expect((schema.schema.author as { kind: string }).kind).toBe('relation');
  });

  test('NoteConfig can be expressed', () => {
    const schema = Private({
      maxNotes: Int({ default: 100 }),
      defaultStatus: Enum(['draft', 'published'], { default: 'draft' }),
    });

    expect(schema.classification.kind).toBe('private');
    expect((schema.schema.maxNotes as { kind: string }).kind).toBe('int');
    expect((schema.schema.defaultStatus as { kind: string }).kind).toBe('enum');
  });
});
