/**
 * Tests for binding context serialization.
 */

import { describe, expect, test } from 'bun:test';
import { createBindingContext } from '../binding-context';
import { serializeBindingContext, serializeInitData } from '../serialize';
import { Str, Lifecycle } from '@janus/vocabulary';
import type { BindingRecord } from '@janus/core';

function makeBinding(entity: string, view: string, fields: Record<string, any>): BindingRecord {
  return {
    source: entity,
    component: () => {},
    view,
    config: { fields },
  };
}

describe('serializeBindingContext', () => {
  test('serializes field values and metadata', () => {
    const binding = makeBinding('task', 'detail', {
      title: { agent: 'read-write', component: 'heading', label: 'Title' },
      status: { agent: 'read', component: 'badge' },
    });

    const ctx = createBindingContext(
      'task', 'task-1', 'detail', binding,
      { title: 'My Task', status: 'pending' },
      { title: Str({ required: true }), status: Lifecycle({ pending: ['done'] }) },
    );

    const serialized = serializeBindingContext(ctx);

    expect(serialized.entity).toBe('task');
    expect(serialized.id).toBe('task-1');
    expect(serialized.view).toBe('detail');
    expect(serialized.fields.title.value).toBe('My Task');
    expect(serialized.fields.title.meta.agent).toBe('read-write');
    expect(serialized.fields.title.meta.component).toBe('heading');
    expect(serialized.fields.status.value).toBe('pending');
    expect(serialized.fields.status.meta.agent).toBe('read');
  });

  test('serializes null id for list views', () => {
    const binding = makeBinding('task', 'list', {
      title: { agent: 'read' },
    });

    const ctx = createBindingContext(
      'task', null, 'list', binding,
      { title: 'Item' },
      { title: Str() },
    );

    const serialized = serializeBindingContext(ctx);
    expect(serialized.id).toBeNull();
  });

  test('handles missing field values as null', () => {
    const binding = makeBinding('task', 'detail', {
      title: { agent: 'read-write' },
    });

    const ctx = createBindingContext(
      'task', 'task-1', 'detail', binding,
      {}, // no title value
      { title: Str() },
    );

    const serialized = serializeBindingContext(ctx);
    expect(serialized.fields.title.value).toBeNull();
  });
});

describe('serializeInitData', () => {
  test('serializes multiple contexts with cursor', () => {
    const binding = makeBinding('task', 'list', {
      title: { agent: 'read' },
    });

    const ctx = createBindingContext(
      'task', null, 'list', binding,
      { title: 'Item' },
      { title: Str() },
    );

    const initData = serializeInitData([ctx], 'cursor-123');

    expect(initData.contexts).toHaveLength(1);
    expect(initData.cursor).toBe('cursor-123');
  });

  test('serializes without cursor', () => {
    const initData = serializeInitData([]);
    expect(initData.contexts).toHaveLength(0);
    expect(initData.cursor).toBeUndefined();
  });
});
