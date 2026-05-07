import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, defineCapability, seedHandlers, clearRegistry } from '..';
import type { InitiatorConfig, ParticipationRecord } from '..';
import { Str, Int, Markdown, DateTime, Lifecycle, Relation, Persistent, Singleton, Derived, Volatile, Enum, QrCode } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Helpers ─────────────────────────────────────────────────────

function setup() {
  seedHandlers();

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      author: Relation('user'),
    },
    storage: Persistent(),
  });

  const user = define('user', {
    schema: { name: Str({ required: true }), email: Str() },
    storage: Persistent(),
  });

  const noteP = participate(note, {});
  const userP = participate(user, {});

  return { note, user, noteP, userP };
}

/** Setup without wiring fields for simpler tests */
function simpleSetup() {
  seedHandlers();

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    },
    storage: Persistent(),
  });

  const noteP = participate(note, {});
  return { note, noteP };
}

// ── Basic compilation ───────────────────────────────────────────

describe('compile() basic', () => {
  test('compiles definitions and participations', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);

    expect(result.graphNodes.size).toBe(2);
    expect(result.graphNodes.has('note')).toBe(true);
    expect(result.graphNodes.has('user')).toBe(true);
  });

  test('compiledAt is set', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);
    expect(result.compiledAt).toBeTruthy();
    expect(new Date(result.compiledAt).getTime()).not.toBeNaN();
  });

  test('persistRouting generated', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);
    expect(result.persistRouting).toHaveLength(2);

    const noteRouting = result.persistRouting.find((r) => r.entity === 'note');
    expect(noteRouting).toBeDefined();
    expect(noteRouting!.adapter).toBe('relational');
    expect(noteRouting!.table).toBe('note');
  });
});

// ── Dispatch index ──────────────────────────────────────────────

describe('compile() dispatch index', () => {
  test('system initiator produces pipelines for all entities', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);

    expect(result.pipeline('system', 'note', 'create')).toBeDefined();
    expect(result.pipeline('system', 'note', 'read')).toBeDefined();
    expect(result.pipeline('system', 'note', 'update')).toBeDefined();
    expect(result.pipeline('system', 'note', 'delete')).toBeDefined();
    expect(result.pipeline('system', 'user', 'create')).toBeDefined();
  });

  test('read pipeline has needsTx=false', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    const pipeline = result.pipeline('system', 'note', 'read')!;
    expect(pipeline.needsTx).toBe(false);
  });

  test('create pipeline has needsTx=true', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    const pipeline = result.pipeline('system', 'note', 'create')!;
    expect(pipeline.needsTx).toBe(true);
  });

  test('pipeline stages are ordered correctly', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    const pipeline = result.pipeline('system', 'note', 'create')!;

    // preTx: parse(20), validate(25), credential-generate(30)
    // tx: store-create(35), emit(40)
    // postTx: respond(70)
    expect(pipeline.preTx).toHaveLength(3);
    expect(pipeline.tx).toHaveLength(2);
    expect(pipeline.postTx).toHaveLength(1);
  });

  test('read pipeline is flat (all preTx)', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    const pipeline = result.pipeline('system', 'note', 'read')!;

    // All non-transactional, so everything in preTx
    expect(pipeline.tx).toHaveLength(0);
    expect(pipeline.postTx).toHaveLength(0);
    // store-read + respond-shaper
    expect(pipeline.preTx.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Derived and Singleton entities ──────────────────────────────

describe('compile() storage variations', () => {
  test('Derived entity only has read pipeline', () => {
    seedHandlers();
    const view = define('published_notes', {
      schema: { title: Str() },
      storage: Derived({ from: 'note', where: { status: 'published' } }),
    });
    const note = define('note', { schema: { title: Str() }, storage: Persistent() });
    const viewP = participate(view, {});
    const noteP = participate(note, {});
    const result = compile([note, view, noteP, viewP]);

    expect(result.pipeline('system', 'published_notes', 'read')).toBeDefined();
    expect(result.pipeline('system', 'published_notes', 'create')).toBeUndefined();
    expect(result.pipeline('system', 'published_notes', 'update')).toBeUndefined();
    expect(result.pipeline('system', 'published_notes', 'delete')).toBeUndefined();
  });

  test('Singleton entity has read + update pipelines', () => {
    seedHandlers();
    const config = define('app_config', {
      schema: { max_items: Int() },
      storage: Singleton({ defaults: { max_items: 100 } }),
    });
    const configP = participate(config, {});
    const result = compile([config, configP]);

    expect(result.pipeline('system', 'app_config', 'read')).toBeDefined();
    expect(result.pipeline('system', 'app_config', 'update')).toBeDefined();
    expect(result.pipeline('system', 'app_config', 'create')).toBeUndefined();
    expect(result.pipeline('system', 'app_config', 'delete')).toBeUndefined();
  });
});

// ── Surface initiators ──────────────────────────────────────────

describe('compile() initiators', () => {
  test('surface initiator adds transport handlers to pipeline', () => {
    seedHandlers();

    const note = define('note', { schema: { title: Str() }, storage: Persistent() });
    const noteP = participate(note, {});

    const apiSurface: InitiatorConfig = {
      name: 'api_surface',
      origin: 'consumer',
      participations: [
        { source: 'api_surface', handler: 'http-receive', order: 5, transactional: false, config: {} },
        { source: 'api_surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
      ],
    };

    const result = compile([note, noteP], [apiSurface]);

    const pipeline = result.pipeline('api_surface', 'note', 'create')!;
    expect(pipeline).toBeDefined();
    expect(pipeline.preTx.length).toBeGreaterThan(2);
    expect(pipeline.postTx.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Transition targets ──────────────────────────────────────────

describe('compile() transition targets', () => {
  test('transition targets reuse update pipeline', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);

    // note has transitions: draft→published, published→archived
    const publishPipeline = result.pipeline('system', 'note', 'published');
    const updatePipeline = result.pipeline('system', 'note', 'update');

    expect(publishPipeline).toBeDefined();
    expect(publishPipeline).toBe(updatePipeline); // same frozen reference
  });
});

// ── Validation ──────────────────────────────────────────────────

describe('compile() validation', () => {
  test('duplicate entity names throw', () => {
    seedHandlers();
    const a = define('note', { schema: {}, storage: Persistent() });
    const b = define('note', { schema: {}, storage: Persistent() });
    expect(() => compile([a, b])).toThrow('Duplicate entity name');
  });

  test('participation with unresolved handler throws', () => {
    seedHandlers();
    const note = define('note', { schema: {}, storage: Persistent() });
    const bad: ParticipationRecord = {
      source: 'note',
      handler: 'nonexistent-handler',
      order: 50,
      transactional: false,
      config: {},
    };
    const badP = { kind: 'participate' as const, records: [bad] };
    expect(() => compile([note, badP])).toThrow('unresolved handler');
  });

  test('wiring target pointing to undefined entity throws', () => {
    seedHandlers();
    const note = define('note', {
      schema: { author: Relation('nonexistent') },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    expect(() => compile([note, noteP])).toThrow("references unknown entity 'nonexistent'");
  });

  // ── Capability validation ─────────────────────────────────────

  test('duplicate capability names throw', () => {
    seedHandlers();
    const a = defineCapability({
      name: 'drive__search',
      description: 'a',
      inputSchema: { q: Str() },
      handler: async () => null,
    });
    const b = defineCapability({
      name: 'drive__search',
      description: 'b',
      inputSchema: { q: Str() },
      handler: async () => null,
    });
    expect(() => compile([a, b])).toThrow('Duplicate capability name');
  });

  test('capability with empty policy role throws at compile', () => {
    seedHandlers();
    const cap = defineCapability({
      name: 'bad__policy',
      description: 'b',
      inputSchema: { x: Str() },
      policy: { rules: [{ role: '', operations: '*' }] },
      handler: async () => null,
    });
    expect(() => compile([cap])).toThrow('role must be a non-empty string');
  });

  test('capability with invalid policy.operations throws', () => {
    seedHandlers();
    const cap = defineCapability({
      name: 'bad__ops',
      description: 'b',
      inputSchema: { x: Str() },
      // @ts-expect-error testing runtime guard
      policy: { rules: [{ role: 'admin', operations: 'admin' }] },
      handler: async () => null,
    });
    expect(() => compile([cap])).toThrow("operations must be '*' or an array");
  });

  test('capability with non-positive rateLimit.max throws', () => {
    seedHandlers();
    const cap = defineCapability({
      name: 'bad__rate',
      description: 'b',
      inputSchema: { x: Str() },
      rateLimit: { max: 0, window: 1000 },
      handler: async () => null,
    });
    expect(() => compile([cap])).toThrow('rateLimit.max must be a positive number');
  });

  test('capability with non-positive rateLimit.window throws', () => {
    seedHandlers();
    const cap = defineCapability({
      name: 'bad__win',
      description: 'b',
      inputSchema: { x: Str() },
      rateLimit: { max: 10, window: -5 },
      handler: async () => null,
    });
    expect(() => compile([cap])).toThrow('rateLimit.window must be a positive number');
  });

  test('capability with non-positive timeout throws', () => {
    seedHandlers();
    const cap = defineCapability({
      name: 'bad__timeout',
      description: 'b',
      inputSchema: { x: Str() },
      timeout: 0,
      handler: async () => null,
    });
    expect(() => compile([cap])).toThrow('timeout must be a positive number');
  });
});

// ── Query helpers ───────────────────────────────────────────────

describe('compile() query helpers', () => {
  test('entity() returns GraphNodeRecord', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    const entity = result.entity('note');
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('note');
  });

  test('entity() returns undefined for unknown', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(result.entity('nonexistent')).toBeUndefined();
  });

  test('participationsFor() returns filtered records', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);
    const noteParts = result.participationsFor('note');
    expect(noteParts.length).toBeGreaterThan(0);
    for (const p of noteParts) {
      expect(p.source).toBe('note');
    }
  });

  test('operationsFor() returns entity operations', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(result.operationsFor('note')).toEqual(['read', 'create', 'update', 'delete']);
  });

  test('operationsFor() returns empty for unknown entity', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(result.operationsFor('nonexistent')).toEqual([]);
  });
});

// ── Demo entities ───────────────────────────────────────────────

describe('compile() demo entities', () => {
  test('all four demo entities compile successfully', () => {
    seedHandlers();

    const adr = define('adr', {
      schema: {
        number: Int({ required: true }),
        title: Str({ required: true }),
        summary: Markdown(),
        status: Lifecycle({
          draft: ['accepted'],
          accepted: ['implemented', 'superseded'],
          implemented: ['superseded'],
        }),
        depends_on: Relation('adr'),
      },
      storage: Persistent(),
    });

    const task = define('task', {
      schema: {
        title: Str({ required: true }),
        description: Markdown(),
        adr: Relation('adr'),
        assignee: Str(),
        priority: Enum(['low', 'medium', 'high']),
        status: Lifecycle({
          pending: ['in_progress', 'blocked'],
          in_progress: ['completed', 'blocked', 'pending'],
          blocked: ['pending', 'in_progress'],
        }),
      },
      storage: Persistent(),
    });

    const test_run = define('test_run', {
      schema: {
        suite: Str({ required: true }),
        passed: Int({ required: true }),
        failed: Int({ required: true }),
        skipped: Int(),
        duration: Int(),
        commit: Str(),
        timestamp: DateTime({ required: true }),
      },
      storage: Persistent(),
    });

    const question = define('question', {
      schema: {
        title: Str({ required: true }),
        context: Markdown(),
        resolution: Markdown(),
        status: Lifecycle({
          open: ['resolved', 'deferred'],
          deferred: ['open'],
        }),
        adr: Relation('adr'),
      },
      storage: Persistent(),
    });

    const adrP = participate(adr, {});
    const taskP = participate(task, {});
    const testRunP = participate(test_run, {});
    const questionP = participate(question, {});

    const result = compile([adr, task, test_run, question, adrP, taskP, testRunP, questionP]);

    expect(result.graphNodes.size).toBe(4);
    expect(result.pipeline('system', 'adr', 'create')).toBeDefined();
    expect(result.pipeline('system', 'task', 'read')).toBeDefined();
    expect(result.pipeline('system', 'test_run', 'create')).toBeDefined();
    expect(result.pipeline('system', 'question', 'update')).toBeDefined();

    // Lifecycle transitions produce dispatch index entries
    expect(result.pipeline('system', 'adr', 'accepted')).toBeDefined();
    expect(result.pipeline('system', 'task', 'in_progress')).toBeDefined();
    expect(result.pipeline('system', 'task', 'completed')).toBeDefined();
  });
});

// ── Wiring index ────────────────────────────────────────────────

describe('compile() wiring index', () => {
  test('Relation produces wiring edge', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);

    expect(result.wiring.edges.length).toBeGreaterThanOrEqual(1);
    const authorEdge = result.wiring.edges.find((e) => e.fromField === 'author');
    expect(authorEdge).toBeDefined();
    expect(authorEdge!.from).toBe('note');
    expect(authorEdge!.to).toBe('user');
    expect(authorEdge!.kind).toBe('relation');
  });

  test('outbound() returns edges from entity', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);

    const outbound = result.wiring.outbound('note');
    expect(outbound.length).toBeGreaterThanOrEqual(1);
    expect(outbound.every((e) => e.from === 'note')).toBe(true);
  });

  test('inbound() returns edges to entity', () => {
    const { note, user, noteP, userP } = setup();
    const result = compile([note, user, noteP, userP]);

    const inbound = result.wiring.inbound('user');
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    expect(inbound.every((e) => e.to === 'user')).toBe(true);
  });

  test('entity with no wiring has empty edges', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(result.wiring.outbound('note')).toHaveLength(0);
  });
});

// ── Initiators map ──────────────────────────────────────────────

describe('compile() initiators', () => {
  test('initiators map includes system', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(result.initiators.has('system')).toBe(true);
    expect(result.initiators.get('system')!.origin).toBe('framework');
  });

  test('initiators map includes consumer surfaces', () => {
    seedHandlers();

    const note = define('note', { schema: { title: Str() }, storage: Persistent() });
    const noteP = participate(note, {});

    const result = compile([note, noteP], [
      { name: 'api_surface', origin: 'consumer', participations: [
        { source: 'api_surface', handler: 'http-receive', order: 5, transactional: false, config: {} },
        { source: 'api_surface', handler: 'http-respond', order: 80, transactional: false, config: {} },
      ]},
    ]);

    expect(result.initiators.has('api_surface')).toBe(true);
    expect(result.initiators.get('api_surface')!.origin).toBe('consumer');
  });
});

// ── Compilation metadata ────────────────────────────────────────

describe('compile() metadata', () => {
  test('compilationDuration is a positive number', () => {
    const { note, noteP } = simpleSetup();
    const result = compile([note, noteP]);
    expect(typeof result.compilationDuration).toBe('number');
    expect(result.compilationDuration).toBeGreaterThanOrEqual(0);
  });
});

// ── Empty input ─────────────────────────────────────────────────

describe('compile() edge cases', () => {
  test('empty declarations compiles to empty result', () => {
    const result = compile([]);
    expect(result.graphNodes.size).toBe(0);
    expect(result.dispatchIndex.size).toBe(0);
    expect(result.persistRouting).toHaveLength(0);
    expect(result.wiring.edges).toHaveLength(0);
  });
});

// ── QrCode expiresWith validation ──────────────────────────────

describe('compile() QrCode expiresWith validation', () => {
  test('valid expiresWith reference compiles successfully', () => {
    seedHandlers();
    const ticket = define('ticket', {
      storage: Persistent(),
      schema: {
        code: QrCode({ length: 8, expiresWith: 'expiresAt' }),
        expiresAt: DateTime(),
      },
    });
    const part = participate(ticket);
    const result = compile([ticket, part]);
    expect(result.graphNodes.has('ticket')).toBe(true);
  });

  test('QrCode without expiresWith compiles successfully', () => {
    seedHandlers();
    const ticket = define('ticket', {
      storage: Persistent(),
      schema: {
        code: QrCode({ length: 8 }),
      },
    });
    const part = participate(ticket);
    const result = compile([ticket, part]);
    expect(result.graphNodes.has('ticket')).toBe(true);
  });

  test('throws when expiresWith references nonexistent field', () => {
    seedHandlers();
    const ticket = define('ticket', {
      storage: Persistent(),
      schema: {
        code: QrCode({ expiresWith: 'missing_field' }),
      },
    });
    const part = participate(ticket);
    expect(() => compile([ticket, part])).toThrow(
      "Entity 'ticket': QrCode field 'code' references expiresWith='missing_field', but that field does not exist",
    );
  });

  test('throws when expiresWith references non-DateTime field', () => {
    seedHandlers();
    const ticket = define('ticket', {
      storage: Persistent(),
      schema: {
        code: QrCode({ expiresWith: 'title' }),
        title: Str(),
      },
    });
    const part = participate(ticket);
    expect(() => compile([ticket, part])).toThrow(
      "Entity 'ticket': QrCode field 'code' references expiresWith='title', but that field is 'str', not 'datetime'",
    );
  });
});
