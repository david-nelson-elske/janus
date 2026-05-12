/**
 * Tests for the minimal JSON Patch diff.
 *
 * Exercises: primitive replace, object key add/remove/replace, array
 * grow / shrink / per-element diff, and RFC 6902 pointer escaping.
 */

import { describe, expect, it } from 'bun:test';
import { diff } from '../patch';

describe('diff', () => {
  it('returns no ops when values are deeply equal', () => {
    expect(diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('emits a replace op for primitive changes', () => {
    expect(diff({ a: 1 }, { a: 2 })).toEqual([
      { op: 'replace', path: '/a', value: 2 },
    ]);
  });

  it('emits add for new keys', () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual([
      { op: 'add', path: '/b', value: 2 },
    ]);
  });

  it('emits remove for missing keys', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual([
      { op: 'remove', path: '/b' },
    ]);
  });

  it('emits add for array growth using /- pointer', () => {
    const ops = diff({ xs: [1, 2] }, { xs: [1, 2, 3, 4] });
    expect(ops).toEqual([
      { op: 'add', path: '/xs/-', value: 3 },
      { op: 'add', path: '/xs/-', value: 4 },
    ]);
  });

  it('emits remove for array shrink', () => {
    const ops = diff({ xs: [1, 2, 3] }, { xs: [1] });
    expect(ops).toEqual([
      { op: 'remove', path: '/xs/2' },
      { op: 'remove', path: '/xs/1' },
    ]);
  });

  it('recurses into nested objects', () => {
    const ops = diff(
      { sections: [{ id: 's1', title: 'A' }] },
      { sections: [{ id: 's1', title: 'B' }] },
    );
    expect(ops).toEqual([
      { op: 'replace', path: '/sections/0/title', value: 'B' },
    ]);
  });

  it('escapes ~ and / in path segments per RFC 6902', () => {
    const ops = diff({ 'a/b': 1, 'c~d': 2 }, { 'a/b': 9, 'c~d': 8 });
    expect(ops).toEqual([
      { op: 'replace', path: '/a~1b', value: 9 },
      { op: 'replace', path: '/c~0d', value: 8 },
    ]);
  });
});
