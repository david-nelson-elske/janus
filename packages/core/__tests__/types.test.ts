import { describe, expect, test } from 'bun:test';
import {
  Created,
  Updated,
  Deleted,
  Acted,
  isMutationEvent,
  isActedEvent,
  ANONYMOUS,
  SYSTEM,
  ALL_OPERATIONS,
  WRITE_OPERATIONS,
  Handler,
} from '..';

describe('Operation', () => {
  test('ALL_OPERATIONS has exactly 4 values', () => {
    expect(ALL_OPERATIONS).toEqual(['read', 'create', 'update', 'delete']);
  });

  test('WRITE_OPERATIONS has exactly 3 values', () => {
    expect(WRITE_OPERATIONS).toEqual(['create', 'update', 'delete']);
  });

  test('ALL_OPERATIONS is frozen', () => {
    expect(Object.isFrozen(ALL_OPERATIONS)).toBe(true);
  });
});

describe('EventDescriptor', () => {
  test('Created is frozen', () => {
    expect(Object.isFrozen(Created)).toBe(true);
    expect(Created.kind).toBe('created');
  });

  test('Updated is frozen', () => {
    expect(Object.isFrozen(Updated)).toBe(true);
    expect(Updated.kind).toBe('updated');
  });

  test('Deleted is frozen', () => {
    expect(Object.isFrozen(Deleted)).toBe(true);
    expect(Deleted.kind).toBe('deleted');
  });

  test('Acted returns frozen descriptor with action', () => {
    const acted = Acted('pin');
    expect(Object.isFrozen(acted)).toBe(true);
    expect(acted.kind).toBe('acted');
    expect((acted as { name: string }).name).toBe('pin');
  });

  test('isMutationEvent returns true for created/updated/deleted', () => {
    expect(isMutationEvent(Created)).toBe(true);
    expect(isMutationEvent(Updated)).toBe(true);
    expect(isMutationEvent(Deleted)).toBe(true);
  });

  test('isMutationEvent returns false for acted', () => {
    expect(isMutationEvent(Acted('pin'))).toBe(false);
  });

  test('isActedEvent returns true for acted', () => {
    expect(isActedEvent(Acted('pin'))).toBe(true);
  });

  test('isActedEvent returns false for mutation events', () => {
    expect(isActedEvent(Created)).toBe(false);
    expect(isActedEvent(Updated)).toBe(false);
    expect(isActedEvent(Deleted)).toBe(false);
  });
});

describe('Handler()', () => {
  test('returns frozen object with kind: handler', () => {
    const h = Handler();
    expect(h.kind).toBe('handler');
    expect(Object.isFrozen(h)).toBe(true);
  });

  test('multiple calls return equal but distinct objects', () => {
    const a = Handler();
    const b = Handler();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('Identity', () => {
  test('ANONYMOUS is frozen', () => {
    expect(Object.isFrozen(ANONYMOUS)).toBe(true);
    expect(ANONYMOUS.id).toBe('anonymous');
    expect(ANONYMOUS.roles).toEqual(['anonymous']);
  });

  test('SYSTEM is frozen', () => {
    expect(Object.isFrozen(SYSTEM)).toBe(true);
    expect(SYSTEM.id).toBe('system');
    expect(SYSTEM.roles).toEqual(['system']);
  });
});
