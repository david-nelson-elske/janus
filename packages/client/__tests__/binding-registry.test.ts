/**
 * Tests for BindingRegistry.
 */

import { describe, expect, test } from 'bun:test';
import { createBindingRegistry } from '../binding-registry';
import { createBindingContext } from '../binding-context';
import { Str } from '@janus/vocabulary';
import type { BindingRecord } from '@janus/core';

function makeCtx(entity: string, id: string | null, view: string) {
  const binding: BindingRecord = {
    source: entity,
    component: () => {},
    view,
    config: { fields: { title: { agent: 'read' as const } } },
  };
  return createBindingContext(entity, id, view, binding, { title: 'Test' }, { title: Str() });
}

describe('BindingRegistry', () => {
  test('starts empty', () => {
    const registry = createBindingRegistry();
    expect(registry.getActiveContexts()).toHaveLength(0);
  });

  test('setActiveContexts updates contexts', () => {
    const registry = createBindingRegistry();
    const ctx = makeCtx('task', null, 'list');
    registry.setActiveContexts([ctx]);
    expect(registry.getActiveContexts()).toHaveLength(1);
    expect(registry.getActiveContexts()[0].entity).toBe('task');
  });

  test('clearActiveContexts empties the list', () => {
    const registry = createBindingRegistry();
    registry.setActiveContexts([makeCtx('task', null, 'list')]);
    registry.clearActiveContexts();
    expect(registry.getActiveContexts()).toHaveLength(0);
  });

  test('onContextsChanged fires on set', () => {
    const registry = createBindingRegistry();
    let called = 0;
    registry.onContextsChanged(() => called++);
    registry.setActiveContexts([makeCtx('task', null, 'list')]);
    expect(called).toBe(1);
  });

  test('onContextsChanged fires on clear', () => {
    const registry = createBindingRegistry();
    let called = 0;
    registry.onContextsChanged(() => called++);
    registry.clearActiveContexts();
    expect(called).toBe(1);
  });

  test('unsubscribe stops notifications', () => {
    const registry = createBindingRegistry();
    let called = 0;
    const unsub = registry.onContextsChanged(() => called++);
    unsub();
    registry.setActiveContexts([makeCtx('task', null, 'list')]);
    expect(called).toBe(0);
  });

  test('contexts are frozen', () => {
    const registry = createBindingRegistry();
    registry.setActiveContexts([makeCtx('task', null, 'list')]);
    expect(() => {
      (registry.getActiveContexts() as any).push(makeCtx('adr', null, 'list'));
    }).toThrow();
  });
});
