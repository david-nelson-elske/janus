import { describe, expect, test } from 'bun:test';
import { serializeICalFeed, parseICalFeed } from '..';

describe('serializeICalFeed()', () => {
  test('produces valid VCALENDAR structure', () => {
    const ics = serializeICalFeed([], { name: 'Test Calendar' });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('X-WR-CALNAME:Test Calendar');
  });

  test('serializes events with all fields', () => {
    const ics = serializeICalFeed([{
      id: 'evt-1',
      start: '2026-06-15T10:00:00Z',
      end: '2026-06-15T12:00:00Z',
      title: 'Board Meeting',
      description: 'Monthly board meeting',
      location: 'Community Hall',
      category: 'meeting',
      sourceCalendar: 'pca',
    }], { name: 'PCA Calendar', domain: 'parkdaleyyc.com' });

    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('UID:evt-1@parkdaleyyc.com');
    expect(ics).toContain('DTSTART:20260615T100000Z');
    expect(ics).toContain('DTEND:20260615T120000Z');
    expect(ics).toContain('SUMMARY:Board Meeting');
    expect(ics).toContain('DESCRIPTION:Monthly board meeting');
    expect(ics).toContain('LOCATION:Community Hall');
    expect(ics).toContain('CATEGORIES:meeting');
    expect(ics).toContain('X-JANUS-CALENDAR:pca');
  });

  test('escapes special characters', () => {
    const ics = serializeICalFeed([{
      id: 'e1',
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
      title: 'New Year, 2026; celebration',
    }], { name: 'Test' });

    expect(ics).toContain('SUMMARY:New Year\\, 2026\\; celebration');
  });

  test('handles epoch ms timestamps', () => {
    const start = Date.UTC(2026, 5, 15, 10, 0, 0); // June 15, 2026 10:00 UTC
    const end = Date.UTC(2026, 5, 15, 12, 0, 0);
    const ics = serializeICalFeed([{
      id: 'e1', start, end, title: 'Test',
    }], { name: 'Test' });

    expect(ics).toContain('DTSTART:20260615T100000Z');
    expect(ics).toContain('DTEND:20260615T120000Z');
  });
});

describe('parseICalFeed()', () => {
  test('parses events from valid iCal text', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:test-1',
      'DTSTART:20260615T100000Z',
      'DTEND:20260615T120000Z',
      'SUMMARY:Test Event',
      'DESCRIPTION:A test',
      'LOCATION:Room 1',
      'CATEGORIES:meeting',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalFeed(ics);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('test-1');
    expect(events[0].summary).toBe('Test Event');
    expect(events[0].start).toBe(Date.UTC(2026, 5, 15, 10, 0, 0));
    expect(events[0].end).toBe(Date.UTC(2026, 5, 15, 12, 0, 0));
    expect(events[0].description).toBe('A test');
    expect(events[0].location).toBe('Room 1');
    expect(events[0].category).toBe('meeting');
  });

  test('handles line unfolding', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:u1',
      'DTSTART:20260101T000000Z',
      'SUMMARY:A very long summary that gets ',
      ' folded across multiple lines',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalFeed(ics);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('A very long summary that gets folded across multiple lines');
  });

  test('handles text unescaping', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:u1',
      'DTSTART:20260101T000000Z',
      'SUMMARY:Hello\\, World\\; Test',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalFeed(ics);
    expect(events[0].summary).toBe('Hello, World; Test');
  });

  test('skips events missing required fields', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:good',
      'DTSTART:20260101T000000Z',
      'SUMMARY:Valid',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:bad',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalFeed(ics);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('good');
  });

  test('handles date-only DTSTART', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:u1',
      'DTSTART:20260315',
      'SUMMARY:All day',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalFeed(ics);
    expect(events[0].start).toBe(Date.UTC(2026, 2, 15));
  });

  test('roundtrips through serialize then parse', () => {
    const original = [{
      id: 'rt-1',
      start: '2026-06-15T10:00:00Z',
      end: '2026-06-15T12:00:00Z',
      title: 'Roundtrip Test',
      description: 'Description with, commas; and semicolons',
      location: 'Room A',
      category: 'test',
    }];

    const ics = serializeICalFeed(original, { name: 'Test', domain: 'test.com' });
    const parsed = parseICalFeed(ics);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).toBe('Roundtrip Test');
    expect(parsed[0].description).toBe('Description with, commas; and semicolons');
    expect(parsed[0].location).toBe('Room A');
    expect(parsed[0].category).toBe('test');
    expect(parsed[0].start).toBe(Date.UTC(2026, 5, 15, 10, 0, 0));
    expect(parsed[0].end).toBe(Date.UTC(2026, 5, 15, 12, 0, 0));
  });
});
