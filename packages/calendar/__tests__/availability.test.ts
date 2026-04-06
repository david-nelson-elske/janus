import { describe, expect, test } from 'bun:test';
import { checkAvailability } from '..';
import type { AvailabilityData } from '..';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Base time: Wednesday 2026-06-10 10:00 UTC
const BASE = Date.UTC(2026, 5, 10, 10, 0, 0);
const NOW = BASE - 2 * HOUR; // 08:00 UTC

const weekdayAvailability: AvailabilityData = {
  windows: [
    { day: 'mon', start: '09:00', end: '17:00' },
    { day: 'tue', start: '09:00', end: '17:00' },
    { day: 'wed', start: '09:00', end: '17:00' },
    { day: 'thu', start: '09:00', end: '17:00' },
    { day: 'fri', start: '09:00', end: '17:00' },
  ],
  blackouts: [],
};

describe('checkAvailability()', () => {
  test('available when within window, no constraints', () => {
    const result = checkAvailability(
      weekdayAvailability,
      { start: BASE, end: BASE + HOUR },
      {},
      [],
      NOW,
    );
    expect(result.available).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('rejects outside availability window (wrong day)', () => {
    // Saturday
    const satStart = Date.UTC(2026, 5, 13, 10, 0, 0);
    const result = checkAvailability(
      weekdayAvailability,
      { start: satStart, end: satStart + HOUR },
      {},
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('outside-window');
  });

  test('rejects outside availability window (wrong time)', () => {
    // Wednesday at 19:00 — after 17:00 window
    const lateStart = Date.UTC(2026, 5, 10, 19, 0, 0);
    const result = checkAvailability(
      weekdayAvailability,
      { start: lateStart, end: lateStart + HOUR },
      {},
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('outside-window');
  });

  test('rejects when within lead time', () => {
    const result = checkAvailability(
      { windows: [], blackouts: [] },
      { start: NOW + 30 * 60 * 1000, end: NOW + 90 * 60 * 1000 },
      { leadTimeMinutes: 60 },
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('lead-time');
  });

  test('passes when outside lead time', () => {
    const result = checkAvailability(
      { windows: [], blackouts: [] },
      { start: NOW + 2 * HOUR, end: NOW + 3 * HOUR },
      { leadTimeMinutes: 60 },
      [],
      NOW,
    );
    expect(result.available).toBe(true);
  });

  test('rejects beyond horizon', () => {
    const result = checkAvailability(
      { windows: [], blackouts: [] },
      { start: NOW + 100 * DAY, end: NOW + 100 * DAY + HOUR },
      { horizonDays: 90 },
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('horizon');
  });

  test('rejects blackout dates', () => {
    const availability: AvailabilityData = {
      windows: [],
      blackouts: ['2026-06-10'],
    };
    const result = checkAvailability(
      availability,
      { start: BASE, end: BASE + HOUR },
      {},
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('blackout');
  });

  test('detects conflicts with existing bookings', () => {
    const result = checkAvailability(
      { windows: [], blackouts: [] },
      { start: BASE, end: BASE + HOUR },
      {},
      [{ id: 'existing-1', start: BASE - 30 * 60 * 1000, end: BASE + 30 * 60 * 1000 }],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations[0].kind).toBe('conflict');
  });

  test('no conflict when bookings do not overlap', () => {
    const result = checkAvailability(
      { windows: [], blackouts: [] },
      { start: BASE, end: BASE + HOUR },
      {},
      [{ id: 'existing-1', start: BASE + 2 * HOUR, end: BASE + 3 * HOUR }],
      NOW,
    );
    expect(result.available).toBe(true);
  });

  test('accumulates multiple violations', () => {
    const availability: AvailabilityData = {
      windows: [{ day: 'mon', start: '09:00', end: '17:00' }],
      blackouts: ['2026-06-10'],
    };
    const result = checkAvailability(
      availability,
      { start: BASE, end: BASE + HOUR }, // Wednesday + blackout
      { leadTimeMinutes: 999999 }, // also too soon
      [],
      NOW,
    );
    expect(result.available).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});
