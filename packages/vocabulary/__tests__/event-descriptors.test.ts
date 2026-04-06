import { describe, expect, test } from 'bun:test';
import {
  Acted,
  ActionInvoked,
  Browsed,
  Created,
  Deleted,
  isActionInvoked,
  isMutationEvent,
  isTransitioned,
  Retrieved,
  Transitioned,
  Updated,
} from '..';
// Internal-only descriptors imported directly for testing
import { Expired, isFrameworkEvent, isQueryEvent, Refreshed, Synced } from '../event-descriptors';

describe('singleton constants', () => {
  test('Created is a frozen singleton', () => {
    expect(Created.kind).toBe('created');
    expect(Object.isFrozen(Created)).toBe(true);
  });

  test('all parameterless descriptors have correct kinds', () => {
    expect(Updated.kind).toBe('updated');
    expect(Deleted.kind).toBe('deleted');
    expect(Browsed.kind).toBe('browsed');
    expect(Retrieved.kind).toBe('retrieved');
    expect(Expired.kind).toBe('expired');
    expect(Refreshed.kind).toBe('refreshed');
    expect(Synced.kind).toBe('synced');
  });

  test('same reference on every access', () => {
    expect(Created).toBe(Created);
    expect(Updated).toBe(Updated);
  });
});

describe('Transitioned', () => {
  test('no args — wildcard', () => {
    const d = Transitioned();
    expect(d.kind).toBe('transitioned');
    expect(d).not.toHaveProperty('to');
    expect(d).not.toHaveProperty('from');
  });

  test('single arg — target state', () => {
    const d = Transitioned('published');
    expect(d.kind).toBe('transitioned');
    expect((d as { to: string }).to).toBe('published');
  });

  test('two string args — from and to', () => {
    const d = Transitioned('published', 'draft');
    expect(d.kind).toBe('transitioned');
    expect((d as { to: string }).to).toBe('published');
    expect((d as { from: string }).from).toBe('draft');
  });

  test('field qualifier', () => {
    const d = Transitioned('captured', { field: 'paymentStatus' });
    expect(d.kind).toBe('transitioned');
    expect((d as { to: string }).to).toBe('captured');
    expect((d as { field: string }).field).toBe('paymentStatus');
  });

  test('returns frozen objects', () => {
    expect(Object.isFrozen(Transitioned())).toBe(true);
    expect(Object.isFrozen(Transitioned('published'))).toBe(true);
  });
});

describe('Acted', () => {
  test('stores action name', () => {
    const d = Acted('cancel');
    expect(d.kind).toBe('acted');
    expect((d as { name: string }).name).toBe('cancel');
  });

  test('returns frozen object', () => {
    expect(Object.isFrozen(Acted('pin'))).toBe(true);
  });
});

describe('type narrowing helpers', () => {
  test('isTransitioned', () => {
    expect(isTransitioned(Transitioned('published'))).toBe(true);
    expect(isTransitioned(Created)).toBe(false);
  });

  test('isActionInvoked', () => {
    expect(isActionInvoked(ActionInvoked('cancel'))).toBe(true);
    expect(isActionInvoked(Created)).toBe(false);
  });

  test('isMutationEvent', () => {
    expect(isMutationEvent(Created)).toBe(true);
    expect(isMutationEvent(Updated)).toBe(true);
    expect(isMutationEvent(Deleted)).toBe(true);
    expect(isMutationEvent(Transitioned())).toBe(true);
    expect(isMutationEvent(Browsed)).toBe(false);
    expect(isMutationEvent(Expired)).toBe(false);
  });

  test('isQueryEvent', () => {
    expect(isQueryEvent(Browsed)).toBe(true);
    expect(isQueryEvent(Retrieved)).toBe(true);
    expect(isQueryEvent(Created)).toBe(false);
  });

  test('isFrameworkEvent', () => {
    expect(isFrameworkEvent(Expired)).toBe(true);
    expect(isFrameworkEvent(Refreshed)).toBe(true);
    expect(isFrameworkEvent(Synced)).toBe(true);
    expect(isFrameworkEvent(Created)).toBe(false);
  });
});
