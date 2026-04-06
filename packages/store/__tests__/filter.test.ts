import { describe, expect, test } from 'bun:test';
import { matchesWhere, matchesFieldFilter, compareValues, isOperatorObject } from '..';

describe('matchesWhere', () => {
  test('bare value equality', () => {
    expect(matchesWhere({ status: 'draft' }, { status: 'draft' })).toBe(true);
    expect(matchesWhere({ status: 'published' }, { status: 'draft' })).toBe(false);
  });

  test('null check', () => {
    expect(matchesWhere({ x: null }, { x: null })).toBe(true);
    expect(matchesWhere({ x: 'a' }, { x: null })).toBe(false);
  });

  test('array shorthand ($in)', () => {
    expect(matchesWhere({ status: 'draft' }, { status: ['draft', 'published'] })).toBe(true);
    expect(matchesWhere({ status: 'archived' }, { status: ['draft', 'published'] })).toBe(false);
  });

  test('multiple fields (AND)', () => {
    const record = { status: 'draft', priority: 'high' };
    expect(matchesWhere(record, { status: 'draft', priority: 'high' })).toBe(true);
    expect(matchesWhere(record, { status: 'draft', priority: 'low' })).toBe(false);
  });

  test('empty where matches everything', () => {
    expect(matchesWhere({ x: 1 }, {})).toBe(true);
  });
});

describe('matchesFieldFilter', () => {
  test('$eq', () => {
    expect(matchesFieldFilter(5, { $eq: 5 })).toBe(true);
    expect(matchesFieldFilter(5, { $eq: 6 })).toBe(false);
  });

  test('$ne', () => {
    expect(matchesFieldFilter(5, { $ne: 6 })).toBe(true);
    expect(matchesFieldFilter(5, { $ne: 5 })).toBe(false);
  });

  test('$gt', () => {
    expect(matchesFieldFilter(10, { $gt: 5 })).toBe(true);
    expect(matchesFieldFilter(5, { $gt: 5 })).toBe(false);
  });

  test('$gte', () => {
    expect(matchesFieldFilter(5, { $gte: 5 })).toBe(true);
    expect(matchesFieldFilter(4, { $gte: 5 })).toBe(false);
  });

  test('$lt', () => {
    expect(matchesFieldFilter(3, { $lt: 5 })).toBe(true);
    expect(matchesFieldFilter(5, { $lt: 5 })).toBe(false);
  });

  test('$lte', () => {
    expect(matchesFieldFilter(5, { $lte: 5 })).toBe(true);
    expect(matchesFieldFilter(6, { $lte: 5 })).toBe(false);
  });

  test('$in', () => {
    expect(matchesFieldFilter('a', { $in: ['a', 'b'] })).toBe(true);
    expect(matchesFieldFilter('c', { $in: ['a', 'b'] })).toBe(false);
  });

  test('$nin', () => {
    expect(matchesFieldFilter('c', { $nin: ['a', 'b'] })).toBe(true);
    expect(matchesFieldFilter('a', { $nin: ['a', 'b'] })).toBe(false);
  });

  test('$like', () => {
    expect(matchesFieldFilter('hello world', { $like: '%world' })).toBe(true);
    expect(matchesFieldFilter('hello', { $like: '%world' })).toBe(false);
  });

  test('$null', () => {
    expect(matchesFieldFilter(null, { $null: true })).toBe(true);
    expect(matchesFieldFilter('x', { $null: true })).toBe(false);
    expect(matchesFieldFilter('x', { $null: false })).toBe(true);
    expect(matchesFieldFilter(null, { $null: false })).toBe(false);
  });
});

describe('matchesFieldFilter — compound operators', () => {
  test('$gt + $lt range on same field', () => {
    expect(matchesFieldFilter(25, { $gt: 10, $lt: 50 })).toBe(true);
    expect(matchesFieldFilter(5, { $gt: 10, $lt: 50 })).toBe(false);
    expect(matchesFieldFilter(50, { $gt: 10, $lt: 50 })).toBe(false);
    expect(matchesFieldFilter(10, { $gt: 10, $lt: 50 })).toBe(false);
  });

  test('$gte + $lte inclusive range', () => {
    expect(matchesFieldFilter(10, { $gte: 10, $lte: 50 })).toBe(true);
    expect(matchesFieldFilter(50, { $gte: 10, $lte: 50 })).toBe(true);
    expect(matchesFieldFilter(9, { $gte: 10, $lte: 50 })).toBe(false);
    expect(matchesFieldFilter(51, { $gte: 10, $lte: 50 })).toBe(false);
  });

  test('$ne + $gt combined', () => {
    expect(matchesFieldFilter(20, { $ne: 15, $gt: 10 })).toBe(true);
    expect(matchesFieldFilter(15, { $ne: 15, $gt: 10 })).toBe(false);
    expect(matchesFieldFilter(5, { $ne: 15, $gt: 10 })).toBe(false);
  });

  test('$in + $ne combined', () => {
    expect(matchesFieldFilter('b', { $in: ['a', 'b', 'c'], $ne: 'a' })).toBe(true);
    expect(matchesFieldFilter('a', { $in: ['a', 'b', 'c'], $ne: 'a' })).toBe(false);
    expect(matchesFieldFilter('d', { $in: ['a', 'b', 'c'], $ne: 'a' })).toBe(false);
  });
});

describe('matchesFieldFilter — edge cases', () => {
  test('$like with middle wildcard', () => {
    expect(matchesFieldFilter('hello world', { $like: 'hello%world' })).toBe(true);
    expect(matchesFieldFilter('hello beautiful world', { $like: 'hello%world' })).toBe(true);
    expect(matchesFieldFilter('goodbye world', { $like: 'hello%world' })).toBe(false);
  });

  test('$like with underscore single-char wildcard', () => {
    expect(matchesFieldFilter('cat', { $like: 'c_t' })).toBe(true);
    expect(matchesFieldFilter('cot', { $like: 'c_t' })).toBe(true);
    expect(matchesFieldFilter('cart', { $like: 'c_t' })).toBe(false);
  });

  test('$like is case insensitive', () => {
    expect(matchesFieldFilter('Hello World', { $like: '%hello%' })).toBe(true);
    expect(matchesFieldFilter('HELLO', { $like: 'hello' })).toBe(true);
  });

  test('$like on non-string value returns false', () => {
    expect(matchesFieldFilter(42, { $like: '%42%' })).toBe(false);
    expect(matchesFieldFilter(null, { $like: '%test%' })).toBe(false);
  });

  test('$in with empty array matches nothing', () => {
    expect(matchesFieldFilter('a', { $in: [] })).toBe(false);
  });

  test('$nin with empty array matches everything', () => {
    expect(matchesFieldFilter('a', { $nin: [] })).toBe(true);
    expect(matchesFieldFilter(null, { $nin: [] })).toBe(true);
  });

  test('string comparison with $gt/$lt', () => {
    expect(matchesFieldFilter('banana', { $gt: 'apple' })).toBe(true);
    expect(matchesFieldFilter('apple', { $gt: 'banana' })).toBe(false);
    expect(matchesFieldFilter('apple', { $lt: 'banana' })).toBe(true);
  });

  test('null value with $gt/$lt returns false (null sorts before all)', () => {
    expect(matchesFieldFilter(null, { $gt: 0 })).toBe(false);
    expect(matchesFieldFilter(null, { $gte: 0 })).toBe(false);
  });

  test('$eq with null', () => {
    expect(matchesFieldFilter(null, { $eq: null })).toBe(true);
    expect(matchesFieldFilter('a', { $eq: null })).toBe(false);
  });

  test('$null combined with $ne', () => {
    // $null: false (must not be null) + $ne: 'bad' (must not be 'bad')
    expect(matchesFieldFilter('good', { $null: false, $ne: 'bad' })).toBe(true);
    expect(matchesFieldFilter('bad', { $null: false, $ne: 'bad' })).toBe(false);
    expect(matchesFieldFilter(null, { $null: false, $ne: 'bad' })).toBe(false);
  });
});

describe('matchesWhere — compound', () => {
  test('operator filter on multiple fields', () => {
    const record = { price: 25, quantity: 100, status: 'active' };
    expect(matchesWhere(record, {
      price: { $gte: 20, $lte: 30 },
      quantity: { $gt: 50 },
      status: 'active',
    })).toBe(true);

    expect(matchesWhere(record, {
      price: { $gte: 20, $lte: 30 },
      quantity: { $gt: 200 },
    })).toBe(false);
  });

  test('null filter value is skipped', () => {
    // When where clause has null value for a field, it matches records where that field is null
    expect(matchesWhere({ x: null, y: 1 }, { x: null, y: 1 })).toBe(true);
  });
});

describe('isOperatorObject', () => {
  test('recognizes operator objects', () => {
    expect(isOperatorObject({ $eq: 5 })).toBe(true);
    expect(isOperatorObject({ $gt: 0, $lt: 100 })).toBe(true);
    expect(isOperatorObject({ $like: '%test%' })).toBe(true);
  });

  test('rejects non-operator objects', () => {
    expect(isOperatorObject('hello')).toBe(false);
    expect(isOperatorObject(42)).toBe(false);
    expect(isOperatorObject(null)).toBe(false);
    expect(isOperatorObject([1, 2, 3])).toBe(false);
    expect(isOperatorObject({ name: 'test' })).toBe(false);
  });
});

describe('compareValues', () => {
  test('ascending', () => {
    expect(compareValues(1, 2, 'asc')).toBeLessThan(0);
    expect(compareValues(2, 1, 'asc')).toBeGreaterThan(0);
    expect(compareValues(1, 1, 'asc')).toBe(0);
  });

  test('descending', () => {
    expect(compareValues(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareValues(2, 1, 'desc')).toBeLessThan(0);
  });

  test('null values sort before non-null', () => {
    expect(compareValues(null, 1, 'asc')).toBeLessThan(0);
    expect(compareValues(1, null, 'asc')).toBeGreaterThan(0);
    expect(compareValues(null, null, 'asc')).toBe(0);
  });

  test('string comparison', () => {
    expect(compareValues('apple', 'banana', 'asc')).toBeLessThan(0);
    expect(compareValues('banana', 'apple', 'asc')).toBeGreaterThan(0);
    expect(compareValues('apple', 'apple', 'asc')).toBe(0);
  });
});
