import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, clearRegistry, seedHandlers } from '..';
import type { ParticipationRecord } from '..';
import { Str, Int, Lifecycle, Persistent, Singleton, Derived, AuditFull } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

function findByHandler(records: readonly ParticipationRecord[], handler: string) {
  return records.filter((r) => r.handler === handler);
}

function findOneByHandler(records: readonly ParticipationRecord[], handler: string) {
  const found = findByHandler(records, handler);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('participate() defaults', () => {
  test('empty config produces standard defaults', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const result = participate(entity, {});

    expect(result.kind).toBe('participate');
    expect(result.records[0]?.source).toBe('note');

    // Should have: parse, validate, credential-generate, 4 CRUD, emit, respond = 9 records
    expect(result.records.length).toBe(9);
  });

  test('default handler keys are correct', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {});

    const handlers = records.map((r) => r.handler);
    expect(handlers).toContain('schema-parse');
    expect(handlers).toContain('schema-validate');
    expect(handlers).toContain('store-read');
    expect(handlers).toContain('store-create');
    expect(handlers).toContain('store-update');
    expect(handlers).toContain('store-delete');
    expect(handlers).toContain('emit-broker');
    expect(handlers).toContain('respond-shaper');
  });

  test('default orders are correct', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {});

    expect(findOneByHandler(records, 'schema-parse').order).toBe(20);
    expect(findOneByHandler(records, 'schema-validate').order).toBe(25);
    expect(findOneByHandler(records, 'store-read').order).toBe(35);
    expect(findOneByHandler(records, 'store-create').order).toBe(35);
    expect(findOneByHandler(records, 'store-update').order).toBe(35);
    expect(findOneByHandler(records, 'store-delete').order).toBe(35);
    expect(findOneByHandler(records, 'emit-broker').order).toBe(40);
    expect(findOneByHandler(records, 'respond-shaper').order).toBe(70);
  });

  test('default transactional flags are correct', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {});

    expect(findOneByHandler(records, 'schema-parse').transactional).toBe(false);
    expect(findOneByHandler(records, 'schema-validate').transactional).toBe(false);
    expect(findOneByHandler(records, 'store-read').transactional).toBe(false);
    expect(findOneByHandler(records, 'store-create').transactional).toBe(true);
    expect(findOneByHandler(records, 'store-update').transactional).toBe(true);
    expect(findOneByHandler(records, 'store-delete').transactional).toBe(true);
    expect(findOneByHandler(records, 'emit-broker').transactional).toBe(true);
    expect(findOneByHandler(records, 'respond-shaper').transactional).toBe(false);
  });

  test('operation filters are correct for parse (write only)', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {});

    expect(findOneByHandler(records, 'schema-parse').operations).toEqual(['create', 'update']);
    expect(findOneByHandler(records, 'store-read').operations).toEqual(['read']);
    expect(findOneByHandler(records, 'respond-shaper').operations).toBeUndefined();
  });
});

describe('participate() storage variations', () => {
  test('Derived entity produces only store-read', () => {
    seedHandlers();
    const entity = define('view', {
      schema: { title: Str() },
      storage: Derived({ from: 'note', where: {} }),
    });
    const { records } = participate(entity, {});

    expect(findByHandler(records, 'store-read')).toHaveLength(1);
    expect(findByHandler(records, 'store-create')).toHaveLength(0);
    expect(findByHandler(records, 'store-update')).toHaveLength(0);
    expect(findByHandler(records, 'store-delete')).toHaveLength(0);
    // No parse, validate, emit for read-only entities
    expect(findByHandler(records, 'schema-parse')).toHaveLength(0);
    expect(findByHandler(records, 'schema-validate')).toHaveLength(0);
    expect(findByHandler(records, 'emit-broker')).toHaveLength(0);
  });

  test('Singleton entity produces store-read + store-update', () => {
    seedHandlers();
    const entity = define('config', {
      schema: { max_items: Int() },
      storage: Singleton({ defaults: { max_items: 100 } }),
    });
    const { records } = participate(entity, {});

    expect(findByHandler(records, 'store-read')).toHaveLength(1);
    expect(findByHandler(records, 'store-update')).toHaveLength(1);
    expect(findByHandler(records, 'store-create')).toHaveLength(0);
    expect(findByHandler(records, 'store-delete')).toHaveLength(0);
  });
});

describe('participate() opt-outs', () => {
  test('parse: false excludes schema-parse', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { parse: false });
    expect(findByHandler(records, 'schema-parse')).toHaveLength(0);
  });

  test('validate: false excludes schema-validate', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { validate: false });
    expect(findByHandler(records, 'schema-validate')).toHaveLength(0);
  });

  test('emit: false excludes emit-broker', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { emit: false });
    expect(findByHandler(records, 'emit-broker')).toHaveLength(0);
  });

  test('respond: false excludes respond-shaper', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { respond: false });
    expect(findByHandler(records, 'respond-shaper')).toHaveLength(0);
  });
});

describe('participate() optional concerns', () => {
  test('policy adds policy-lookup at order=10', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {
      policy: { rules: [{ role: 'admin', operations: '*' }] },
    });
    const policy = findOneByHandler(records, 'policy-lookup');
    expect(policy.order).toBe(10);
    expect(policy.transactional).toBe(false);
  });

  test('audit short form adds audit-relational for writes only', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { audit: AuditFull });
    const audit = findOneByHandler(records, 'audit-relational');
    expect(audit.order).toBe(50);
    expect(audit.transactional).toBe(true);
    expect(audit.operations).toEqual(['create', 'update', 'delete']);
  });

  test('audit expanded form with operations: * audits all operations', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { audit: { level: AuditFull, operations: '*' } });
    const audit = findOneByHandler(records, 'audit-relational');
    expect(audit.operations).toBeUndefined(); // undefined = all operations
  });

  test('audit expanded form with specific operations', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, { audit: { level: AuditFull, operations: ['create', 'read'] } });
    const audit = findOneByHandler(records, 'audit-relational');
    expect(audit.operations).toEqual(['create', 'read']);
  });
});

describe('participate() inline actions', () => {
  test('action registers handler and creates participation record', () => {
    seedHandlers();
    const pinHandler = async () => {};
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {
      actions: {
        pin: { handler: pinHandler, kind: 'mutation', description: 'Pin a note' },
      },
    });

    const action = findOneByHandler(records, 'note:pin');
    expect(action.order).toBe(35);
    expect(action.transactional).toBe(true);
    expect(action.config).toEqual({ kind: 'mutation', actionName: 'pin', scoped: undefined, inputSchema: undefined });
  });

  test('query action has transactional=false', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {
      actions: {
        search: { handler: async () => {}, kind: 'query' },
      },
    });
    const action = findOneByHandler(records, 'note:search');
    expect(action.transactional).toBe(false);
  });

  test('effect action has transactional=false', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const { records } = participate(entity, {
      actions: {
        sync: { handler: async () => {}, kind: 'effect' },
      },
    });
    const action = findOneByHandler(records, 'note:sync');
    expect(action.transactional).toBe(false);
  });

  test('action kind is required', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    // TypeScript enforces kind is required — this test documents the intent
    const { records } = participate(entity, {
      actions: {
        pin: { handler: async () => {}, kind: 'mutation' },
      },
    });
    expect(findOneByHandler(records, 'note:pin').config).toHaveProperty('kind', 'mutation');
  });
});

describe('participate() entity name resolution', () => {
  test('string entity name used directly', () => {
    seedHandlers();
    const result = participate('note', {});
    expect(result.records[0]?.source).toBe('note');
    expect(result.records[0].source).toBe('note');
  });

  test('DefineResult entity name resolved', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const result = participate(entity, {});
    expect(result.records[0]?.source).toBe('note');
  });
});

describe('participate() freezing', () => {
  test('result is frozen', () => {
    seedHandlers();
    const entity = define('note', { schema: { title: Str() }, storage: Persistent() });
    const result = participate(entity, {});
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    for (const r of result.records) {
      expect(Object.isFrozen(r)).toBe(true);
    }
  });
});
