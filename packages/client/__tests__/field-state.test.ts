import { describe, expect, test } from 'bun:test';
import { createFieldState } from '..';
import type { FieldMeta } from '..';

const strMeta: FieldMeta = { type: 'str', agent: 'read-write', component: 'heading', label: 'Title' };
const intMeta: FieldMeta = { type: 'int', agent: 'read' };

describe('createFieldState()', () => {
  test('initializes committed and current to the same value', () => {
    const fs = createFieldState('hello', strMeta);
    expect(fs.committed.value).toBe('hello');
    expect(fs.current.value).toBe('hello');
  });

  test('starts not dirty', () => {
    const fs = createFieldState('hello', strMeta);
    expect(fs.dirty.value).toBe(false);
  });

  test('becomes dirty when current changes', () => {
    const fs = createFieldState('hello', strMeta);
    fs.current.value = 'world';
    expect(fs.dirty.value).toBe(true);
  });

  test('becomes clean when current reverts to committed', () => {
    const fs = createFieldState('hello', strMeta);
    fs.current.value = 'world';
    expect(fs.dirty.value).toBe(true);
    fs.current.value = 'hello';
    expect(fs.dirty.value).toBe(false);
  });

  test('becomes clean when committed catches up', () => {
    const fs = createFieldState('hello', strMeta);
    fs.current.value = 'world';
    expect(fs.dirty.value).toBe(true);
    fs.committed.value = 'world';
    expect(fs.dirty.value).toBe(false);
  });

  test('preserves meta', () => {
    const fs = createFieldState('hello', strMeta);
    expect(fs.meta.type).toBe('str');
    expect(fs.meta.agent).toBe('read-write');
    expect(fs.meta.component).toBe('heading');
    expect(fs.meta.label).toBe('Title');
  });

  test('works with numeric values', () => {
    const fs = createFieldState(42, intMeta);
    expect(fs.committed.value).toBe(42);
    expect(fs.current.value).toBe(42);
    expect(fs.dirty.value).toBe(false);
    fs.current.value = 99;
    expect(fs.dirty.value).toBe(true);
  });

  test('works with null values', () => {
    const fs = createFieldState(null, strMeta);
    expect(fs.committed.value).toBeNull();
    expect(fs.dirty.value).toBe(false);
    fs.current.value = 'something';
    expect(fs.dirty.value).toBe(true);
  });
});
