/**
 * Unit tests for the cron expression parser.
 */

import { describe, expect, test } from 'bun:test';
import { parseCron, cronMatchesDate, nextCronMatch } from '..';

describe('parseCron()', () => {
  test('parses "every minute" expression', () => {
    const fields = parseCron('* * * * *');
    expect(fields.minute).toHaveLength(60);
    expect(fields.hour).toHaveLength(24);
    expect(fields.dayOfMonth).toHaveLength(31);
    expect(fields.month).toHaveLength(12);
    expect(fields.dayOfWeek).toHaveLength(7);
  });

  test('parses exact values', () => {
    const fields = parseCron('30 12 15 6 3');
    expect(fields.minute).toEqual([30]);
    expect(fields.hour).toEqual([12]);
    expect(fields.dayOfMonth).toEqual([15]);
    expect(fields.month).toEqual([6]);
    expect(fields.dayOfWeek).toEqual([3]);
  });

  test('parses step values', () => {
    const fields = parseCron('*/15 */6 * * *');
    expect(fields.minute).toEqual([0, 15, 30, 45]);
    expect(fields.hour).toEqual([0, 6, 12, 18]);
  });

  test('parses ranges', () => {
    const fields = parseCron('0-5 9-17 * * *');
    expect(fields.minute).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test('parses comma-separated lists', () => {
    const fields = parseCron('0,15,30,45 * * * *');
    expect(fields.minute).toEqual([0, 15, 30, 45]);
  });

  test('parses range with step', () => {
    const fields = parseCron('0-30/10 * * * *');
    expect(fields.minute).toEqual([0, 10, 20, 30]);
  });

  test('deduplicates and sorts values', () => {
    const fields = parseCron('30,15,30,0 * * * *');
    expect(fields.minute).toEqual([0, 15, 30]);
  });

  test('midnight daily: 0 0 * * *', () => {
    const fields = parseCron('0 0 * * *');
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([0]);
    expect(fields.dayOfMonth).toHaveLength(31);
  });

  test('rejects invalid field count', () => {
    expect(() => parseCron('* * *')).toThrow('expected 5 fields');
    expect(() => parseCron('* * * * * *')).toThrow('expected 5 fields');
  });

  test('parses mixed commas and ranges', () => {
    const fields = parseCron('1-5,10,20-25 * * * *');
    expect(fields.minute).toEqual([1, 2, 3, 4, 5, 10, 20, 21, 22, 23, 24, 25]);
  });

  test('wildcard with all other fields exact', () => {
    const fields = parseCron('0 12 25 12 *');
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([12]);
    expect(fields.dayOfMonth).toEqual([25]);
    expect(fields.month).toEqual([12]);
    expect(fields.dayOfWeek).toHaveLength(7); // all days
  });

  test('single value for each field', () => {
    const fields = parseCron('0 0 1 1 0');
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([0]);
    expect(fields.dayOfMonth).toEqual([1]);
    expect(fields.month).toEqual([1]);
    expect(fields.dayOfWeek).toEqual([0]);
  });

  test('step on range subexpression', () => {
    // Every 3rd minute from 0-20
    const fields = parseCron('0-20/3 * * * *');
    expect(fields.minute).toEqual([0, 3, 6, 9, 12, 15, 18]);
  });

  test('empty string throws', () => {
    expect(() => parseCron('')).toThrow();
  });
});

describe('cronMatchesDate()', () => {
  test('matches every-minute expression', () => {
    const fields = parseCron('* * * * *');
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:30:00Z'))).toBe(true);
  });

  test('matches exact minute and hour', () => {
    const fields = parseCron('30 12 * * *');
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:30:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:31:00Z'))).toBe(false);
    expect(cronMatchesDate(fields, new Date('2026-04-04T11:30:00Z'))).toBe(false);
  });

  test('matches day of week (Friday = 5)', () => {
    const fields = parseCron('0 9 * * 5');
    // 2026-04-03 is a Friday
    expect(cronMatchesDate(fields, new Date('2026-04-03T09:00:00'))).toBe(true);
    // 2026-04-04 is a Saturday
    expect(cronMatchesDate(fields, new Date('2026-04-04T09:00:00'))).toBe(false);
  });

  test('matches step expression', () => {
    const fields = parseCron('*/15 * * * *');
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:00:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:15:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:07:00Z'))).toBe(false);
  });

  test('does not match wrong month', () => {
    const fields = parseCron('0 0 1 6 *'); // June 1st midnight
    // April 1st — wrong month
    expect(cronMatchesDate(fields, new Date('2026-04-01T00:00:00Z'))).toBe(false);
    // June 1st — correct
    expect(cronMatchesDate(fields, new Date('2026-06-01T00:00:00Z'))).toBe(true);
  });

  test('does not match wrong day of month', () => {
    const fields = parseCron('0 12 15 * *'); // 15th of every month at noon
    expect(cronMatchesDate(fields, new Date('2026-04-15T12:00:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-14T12:00:00Z'))).toBe(false);
  });

  test('comma list matching', () => {
    const fields = parseCron('0,30 * * * *'); // minute 0 and 30
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:00:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:30:00Z'))).toBe(true);
    expect(cronMatchesDate(fields, new Date('2026-04-04T12:15:00Z'))).toBe(false);
  });
});

describe('nextCronMatch()', () => {
  test('finds next minute for every-minute expression', () => {
    const fields = parseCron('* * * * *');
    const after = new Date('2026-04-04T12:30:45Z');
    const next = nextCronMatch(fields, after);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });

  test('finds next occurrence of specific time', () => {
    const fields = parseCron('0 9 * * *');
    const after = new Date('2026-04-04T10:00:00Z');
    const next = nextCronMatch(fields, after);
    // Next 9:00 is the following day
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(5);
  });

  test('finds next midnight from afternoon', () => {
    const fields = parseCron('0 0 * * *');
    const after = new Date('2026-04-04T15:00:00Z');
    const next = nextCronMatch(fields, after);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(5);
  });

  test('skips current minute', () => {
    const fields = parseCron('30 12 * * *');
    // Even if "after" is exactly at 12:30, it should find the NEXT 12:30
    const after = new Date('2026-04-04T12:30:00Z');
    const next = nextCronMatch(fields, after);
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(30);
  });

  test('handles every-6-hours expression', () => {
    const fields = parseCron('0 */6 * * *');
    const after = new Date('2026-04-04T07:00:00Z');
    const next = nextCronMatch(fields, after);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(0);
  });

  test('wraps to next month', () => {
    const fields = parseCron('0 0 1 * *'); // 1st of every month
    const after = new Date('2026-04-15T00:00:00Z');
    const next = nextCronMatch(fields, after);
    expect(next.getMonth()).toBe(4); // May (0-indexed)
    expect(next.getDate()).toBe(1);
  });

  test('every 30 minutes', () => {
    const fields = parseCron('*/30 * * * *');
    const after = new Date('2026-04-04T12:15:00Z');
    const next = nextCronMatch(fields, after);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(12);
  });

  test('next occurrence wraps year boundary', () => {
    const fields = parseCron('0 0 1 1 *'); // Jan 1st midnight
    const after = new Date('2026-06-15T00:00:00Z');
    const next = nextCronMatch(fields, after);
    // Should be Jan 1 of next year
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });
});
