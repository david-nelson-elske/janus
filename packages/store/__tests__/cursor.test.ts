import { describe, expect, test } from 'bun:test';
import { encodeCursor, decodeCursor } from '..';
import type { CursorPayload } from '..';

describe('encodeCursor', () => {
  test('returns a base64 string', () => {
    const payload: CursorPayload = { v: 'hello', id: '123', d: 'asc' };
    const encoded = encodeCursor(payload);
    expect(typeof encoded).toBe('string');
    // base64 characters only
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('decodeCursor', () => {
  test('parses back to CursorPayload', () => {
    const payload: CursorPayload = { v: 'hello', id: '123', d: 'asc' };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded.v).toBe('hello');
    expect(decoded.id).toBe('123');
    expect(decoded.d).toBe('asc');
  });
});

describe('round-trip', () => {
  test('string value with asc direction', () => {
    const payload: CursorPayload = { v: 'test-value', id: 'abc-def', d: 'asc' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  test('numeric value with desc direction', () => {
    const payload: CursorPayload = { v: 42, id: 'record-99', d: 'desc' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  test('null value', () => {
    const payload: CursorPayload = { v: null, id: 'x', d: 'asc' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  test('boolean value', () => {
    const payload: CursorPayload = { v: true, id: 'y', d: 'desc' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });
});
