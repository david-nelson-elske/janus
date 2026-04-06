import { describe, expect, test } from 'bun:test';
import { parseRRule, expandRRule } from '..';

describe('parseRRule()', () => {
  test('parses WEEKLY with BYDAY', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(r.freq).toBe('WEEKLY');
    expect(r.interval).toBe(1);
    expect(r.byDay).toEqual(['MO', 'WE', 'FR']);
  });

  test('parses with RRULE: prefix', () => {
    const r = parseRRule('RRULE:FREQ=DAILY;COUNT=5');
    expect(r.freq).toBe('DAILY');
    expect(r.count).toBe(5);
  });

  test('parses UNTIL date', () => {
    const r = parseRRule('FREQ=WEEKLY;UNTIL=20260531');
    expect(r.until).toBeDefined();
    expect(r.until!.getUTCFullYear()).toBe(2026);
    expect(r.until!.getUTCMonth()).toBe(4); // May = 4
    expect(r.until!.getUTCDate()).toBe(31);
  });

  test('parses UNTIL datetime', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=20260315T120000Z');
    expect(r.until!.getUTCHours()).toBe(12);
  });

  test('parses INTERVAL', () => {
    const r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU');
    expect(r.interval).toBe(2);
    expect(r.byDay).toEqual(['TU']);
  });

  test('parses MONTHLY with BYMONTHDAY', () => {
    const r = parseRRule('FREQ=MONTHLY;BYMONTHDAY=1,15');
    expect(r.freq).toBe('MONTHLY');
    expect(r.byMonthDay).toEqual([1, 15]);
  });

  test('parses BYMONTH', () => {
    const r = parseRRule('FREQ=YEARLY;BYMONTH=6,7,8');
    expect(r.byMonth).toEqual([6, 7, 8]);
  });

  test('throws on missing FREQ', () => {
    expect(() => parseRRule('BYDAY=MO')).toThrow('Unsupported or missing FREQ');
  });
});

describe('expandRRule()', () => {
  test('WEEKLY with BYDAY expands correctly', () => {
    const dates = expandRRule('FREQ=WEEKLY;BYDAY=WE;COUNT=4', {
      start: new Date('2026-03-04T10:00:00Z'), // a Wednesday
    });
    expect(dates).toHaveLength(4);
    expect(dates[0].toISOString()).toBe('2026-03-04T10:00:00.000Z');
    expect(dates[1].toISOString()).toBe('2026-03-11T10:00:00.000Z');
    expect(dates[2].toISOString()).toBe('2026-03-18T10:00:00.000Z');
    expect(dates[3].toISOString()).toBe('2026-03-25T10:00:00.000Z');
  });

  test('WEEKLY with multiple BYDAY', () => {
    const dates = expandRRule('FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4', {
      start: new Date('2026-03-02T09:00:00Z'), // a Monday
    });
    expect(dates).toHaveLength(4);
    // Mon, Fri, Mon, Fri
    expect(dates[0].getUTCDay()).toBe(1); // Monday
    expect(dates[1].getUTCDay()).toBe(5); // Friday
    expect(dates[2].getUTCDay()).toBe(1); // Monday
    expect(dates[3].getUTCDay()).toBe(5); // Friday
  });

  test('DAILY with COUNT', () => {
    const dates = expandRRule('FREQ=DAILY;COUNT=3', {
      start: new Date('2026-06-01T08:00:00Z'),
    });
    expect(dates).toHaveLength(3);
    expect(dates[0].getUTCDate()).toBe(1);
    expect(dates[1].getUTCDate()).toBe(2);
    expect(dates[2].getUTCDate()).toBe(3);
  });

  test('MONTHLY with BYMONTHDAY', () => {
    const dates = expandRRule('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3', {
      start: new Date('2026-01-01T10:00:00Z'),
    });
    expect(dates).toHaveLength(3);
    expect(dates[0].getUTCDate()).toBe(15);
    expect(dates[0].getUTCMonth()).toBe(0); // Jan
    expect(dates[1].getUTCMonth()).toBe(1); // Feb
    expect(dates[2].getUTCMonth()).toBe(2); // Mar
  });

  test('UNTIL limits expansion', () => {
    const dates = expandRRule('FREQ=DAILY;UNTIL=20260305', {
      start: new Date('2026-03-01T10:00:00Z'),
    });
    expect(dates).toHaveLength(5); // Mar 1-5
    expect(dates[dates.length - 1].getUTCDate()).toBe(5);
  });

  test('INTERVAL=2 skips weeks', () => {
    const dates = expandRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3', {
      start: new Date('2026-03-02T09:00:00Z'), // Monday
    });
    expect(dates).toHaveLength(3);
    // Mar 2, Mar 16, Mar 30 (every other Monday)
    expect(dates[0].getUTCDate()).toBe(2);
    expect(dates[1].getUTCDate()).toBe(16);
    expect(dates[2].getUTCDate()).toBe(30);
  });

  test('respects maxInstances safety limit', () => {
    const dates = expandRRule('FREQ=DAILY', {
      start: new Date('2026-01-01T00:00:00Z'),
      maxInstances: 10,
    });
    expect(dates).toHaveLength(10);
  });

  test('YEARLY expansion', () => {
    const dates = expandRRule('FREQ=YEARLY;COUNT=3', {
      start: new Date('2026-07-04T00:00:00Z'),
      horizon: new Date('2030-01-01T00:00:00Z'),
    });
    expect(dates).toHaveLength(3);
    expect(dates[0].getUTCFullYear()).toBe(2026);
    expect(dates[1].getUTCFullYear()).toBe(2027);
    expect(dates[2].getUTCFullYear()).toBe(2028);
  });
});
