/**
 * Tests for temporal invariant helpers: TimeGate, FieldCompare, duration helpers.
 *
 * Unit tests for the predicate functions + integration tests via participate() + dispatch.
 */

import { describe, expect, test } from 'bun:test';
import {
  TimeGate,
  FieldCompare,
  Hours,
  Days,
  Minutes,
} from '..';

// ── Duration helpers ────────────────────────────────────────────

describe('duration helpers', () => {
  test('Minutes(n) returns milliseconds', () => {
    expect(Minutes(1)).toBe(60_000);
    expect(Minutes(30)).toBe(1_800_000);
  });

  test('Hours(n) returns milliseconds', () => {
    expect(Hours(1)).toBe(3_600_000);
    expect(Hours(24)).toBe(86_400_000);
  });

  test('Days(n) returns milliseconds', () => {
    expect(Days(1)).toBe(86_400_000);
    expect(Days(7)).toBe(604_800_000);
  });
});

// ── TimeGate unit tests ─────────────────────────────────────────

describe('TimeGate()', () => {
  test('returns InvariantConfig with correct shape', () => {
    const inv = TimeGate('startsAt', Days(1));
    expect(inv.name).toBe('time-gate:startsAt:before');
    expect(inv.severity).toBe('error');
    expect(typeof inv.predicate).toBe('function');
  });

  test('before: passes when field is far enough in the future', () => {
    const inv = TimeGate('startsAt', Hours(1));
    const future = new Date(Date.now() + Hours(2)).toISOString();
    expect(inv.predicate({ startsAt: future })).toBe(true);
  });

  test('before: fails when field is too soon', () => {
    const inv = TimeGate('startsAt', Hours(24));
    const soon = new Date(Date.now() + Hours(1)).toISOString();
    expect(inv.predicate({ startsAt: soon })).toBe(false);
  });

  test('not-beyond: passes when field is close enough', () => {
    const inv = TimeGate('startsAt', Hours(2), { direction: 'not-beyond' });
    const soon = new Date(Date.now() + Hours(1)).toISOString();
    expect(inv.predicate({ startsAt: soon })).toBe(true);
  });

  test('not-beyond: fails when field is too far out', () => {
    const inv = TimeGate('startsAt', Hours(2), { direction: 'not-beyond' });
    const far = new Date(Date.now() + Days(7)).toISOString();
    expect(inv.predicate({ startsAt: far })).toBe(false);
  });

  test('since: passes when field is far enough in the past', () => {
    const inv = TimeGate('closedAt', Days(7), { direction: 'since' });
    const oldDate = new Date(Date.now() - Days(14)).toISOString();
    expect(inv.predicate({ closedAt: oldDate })).toBe(true);
  });

  test('since: fails when field is too recent', () => {
    const inv = TimeGate('closedAt', Days(7), { direction: 'since' });
    const recent = new Date(Date.now() - Days(1)).toISOString();
    expect(inv.predicate({ closedAt: recent })).toBe(false);
  });

  test('skips null/undefined fields (passes)', () => {
    const inv = TimeGate('startsAt', Days(1));
    expect(inv.predicate({ startsAt: null })).toBe(true);
    expect(inv.predicate({ startsAt: undefined })).toBe(true);
    expect(inv.predicate({})).toBe(true);
  });

  test('custom severity and message', () => {
    const inv = TimeGate('startsAt', Days(1), {
      severity: 'warning',
      message: 'Please schedule further ahead',
    });
    expect(inv.severity).toBe('warning');
    expect(inv.message).toBe('Please schedule further ahead');
  });
});

// ── FieldCompare unit tests ─────────────────────────────────────

describe('FieldCompare()', () => {
  test('returns InvariantConfig with correct shape', () => {
    const inv = FieldCompare('startsAt', 'lt', 'endsAt');
    expect(inv.name).toBe('field-compare:startsAt:lt:endsAt');
    expect(inv.severity).toBe('error');
  });

  test('lt: passes when a < b', () => {
    const inv = FieldCompare('min', 'lt', 'max');
    expect(inv.predicate({ min: 10, max: 20 })).toBe(true);
  });

  test('lt: fails when a >= b', () => {
    const inv = FieldCompare('min', 'lt', 'max');
    expect(inv.predicate({ min: 20, max: 10 })).toBe(false);
    expect(inv.predicate({ min: 10, max: 10 })).toBe(false);
  });

  test('lte: passes when a <= b', () => {
    const inv = FieldCompare('min', 'lte', 'max');
    expect(inv.predicate({ min: 10, max: 10 })).toBe(true);
    expect(inv.predicate({ min: 5, max: 10 })).toBe(true);
  });

  test('gt/gte work correctly', () => {
    const gt = FieldCompare('a', 'gt', 'b');
    expect(gt.predicate({ a: 20, b: 10 })).toBe(true);
    expect(gt.predicate({ a: 10, b: 10 })).toBe(false);

    const gte = FieldCompare('a', 'gte', 'b');
    expect(gte.predicate({ a: 10, b: 10 })).toBe(true);
  });

  test('eq/neq work correctly', () => {
    const eq = FieldCompare('a', 'eq', 'b');
    expect(eq.predicate({ a: 10, b: 10 })).toBe(true);
    expect(eq.predicate({ a: 10, b: 20 })).toBe(false);

    const neq = FieldCompare('a', 'neq', 'b');
    expect(neq.predicate({ a: 10, b: 20 })).toBe(true);
    expect(neq.predicate({ a: 10, b: 10 })).toBe(false);
  });

  test('works with DateTime strings', () => {
    const inv = FieldCompare('startsAt', 'lt', 'endsAt');
    const start = '2026-04-06T10:00:00Z';
    const end = '2026-04-06T12:00:00Z';
    expect(inv.predicate({ startsAt: start, endsAt: end })).toBe(true);
    expect(inv.predicate({ startsAt: end, endsAt: start })).toBe(false);
  });

  test('skips when either field is null/undefined (passes)', () => {
    const inv = FieldCompare('a', 'lt', 'b');
    expect(inv.predicate({ a: 10 })).toBe(true);
    expect(inv.predicate({ b: 10 })).toBe(true);
    expect(inv.predicate({})).toBe(true);
  });
});

// Pipeline integration tests are in pipeline/__tests__/invariant-helpers.test.ts
// (core cannot import from store/pipeline)
