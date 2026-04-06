import { describe, expect, test } from 'bun:test';
import { StoreException, entityNotFound, versionConflict, readOnlyEntity } from '..';
import type { StoreError } from '..';

describe('StoreException', () => {
  test('extends Error', () => {
    const err = new StoreException({ kind: 'not-found', entity: 'note', id: '123' });
    expect(err).toBeInstanceOf(Error);
  });

  test('has name "StoreException"', () => {
    const err = new StoreException({ kind: 'not-found', entity: 'note', id: '123' });
    expect(err.name).toBe('StoreException');
  });

  test('exposes structured .error property', () => {
    const error: StoreError = { kind: 'not-found', entity: 'note', id: '123' };
    const err = new StoreException(error);
    expect(err.error).toBe(error);
    expect(err.error.kind).toBe('not-found');
  });

  test('exposes .kind for dispatch error mapping', () => {
    const err = new StoreException({ kind: 'not-found', entity: 'note', id: '123' });
    expect(err.kind).toBe('not-found');

    const err2 = new StoreException({ kind: 'version-conflict', entity: 'note', id: '1', expected: 1, actual: 2 });
    expect(err2.kind).toBe('version-conflict');
  });
});

describe('entityNotFound()', () => {
  test('returns StoreException with kind not-found', () => {
    const err = entityNotFound('note', '123');
    expect(err).toBeInstanceOf(StoreException);
    expect(err.error.kind).toBe('not-found');
  });

  test('message includes entity and id', () => {
    const err = entityNotFound('note', 'abc-123');
    expect(err.message).toContain('note');
    expect(err.message).toContain('abc-123');
    expect(err.message).toContain('not found');
  });
});

describe('versionConflict()', () => {
  test('returns StoreException with kind version-conflict', () => {
    const err = versionConflict('note', '123', 2, 5);
    expect(err).toBeInstanceOf(StoreException);
    expect(err.error.kind).toBe('version-conflict');
  });

  test('error includes expected and actual versions', () => {
    const err = versionConflict('note', '123', 2, 5);
    const error = err.error as { kind: 'version-conflict'; expected: number; actual: number };
    expect(error.expected).toBe(2);
    expect(error.actual).toBe(5);
  });

  test('message includes expected and actual', () => {
    const err = versionConflict('note', '123', 2, 5);
    expect(err.message).toContain('expected 2');
    expect(err.message).toContain('actual 5');
  });
});

describe('readOnlyEntity()', () => {
  test('returns StoreException with kind read-only', () => {
    const err = readOnlyEntity('config', 'create');
    expect(err).toBeInstanceOf(StoreException);
    expect(err.error.kind).toBe('read-only');
  });

  test('error includes operation', () => {
    const err = readOnlyEntity('config', 'create');
    const error = err.error as { kind: 'read-only'; operation: string };
    expect(error.operation).toBe('create');
  });

  test('message includes entity and operation', () => {
    const err = readOnlyEntity('config', 'delete');
    expect(err.message).toContain('config');
    expect(err.message).toContain('delete');
    expect(err.message).toContain('read-only');
  });
});

describe('all error kinds format messages', () => {
  test('not-found', () => {
    const err = new StoreException({ kind: 'not-found', entity: 'note', id: '1' });
    expect(err.message).toMatch(/note.*1.*not found/);
  });

  test('conflict without field', () => {
    const err = new StoreException({ kind: 'conflict', entity: 'note', id: '1' });
    expect(err.message).toContain('conflict');
    expect(err.message).not.toContain("field");
  });

  test('conflict with field', () => {
    const err = new StoreException({ kind: 'conflict', entity: 'note', id: '1', field: 'slug' });
    expect(err.message).toContain('slug');
  });

  test('version-conflict', () => {
    const err = new StoreException({ kind: 'version-conflict', entity: 'note', id: '1', expected: 3, actual: 7 });
    expect(err.message).toContain('version conflict');
    expect(err.message).toContain('3');
    expect(err.message).toContain('7');
  });

  test('read-only', () => {
    const err = new StoreException({ kind: 'read-only', entity: 'config', operation: 'update' });
    expect(err.message).toContain('read-only');
    expect(err.message).toContain('update');
  });

  test('invalid-query', () => {
    const err = new StoreException({ kind: 'invalid-query', entity: 'note', detail: 'bad sort field' });
    expect(err.message).toContain('Invalid query');
    expect(err.message).toContain('bad sort field');
  });

  test('constraint-violation without detail', () => {
    const err = new StoreException({ kind: 'constraint-violation', entity: 'note', constraint: 'unique_slug' });
    expect(err.message).toContain('constraint');
    expect(err.message).toContain('unique_slug');
  });

  test('constraint-violation with detail', () => {
    const err = new StoreException({ kind: 'constraint-violation', entity: 'note', constraint: 'unique_slug', detail: 'duplicate value' });
    expect(err.message).toContain('duplicate value');
  });

  test('transaction-failed', () => {
    const err = new StoreException({ kind: 'transaction-failed', entity: 'note', reason: 'deadlock' });
    expect(err.message).toContain('Transaction failed');
    expect(err.message).toContain('deadlock');
  });
});
