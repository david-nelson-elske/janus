/**
 * Tests for SSE → signal bridge (updateBindingContexts).
 */

import { describe, expect, test } from 'bun:test';
import { createBindingContext } from '../binding-context';
import { updateBindingContexts, removeFromBindingContexts } from '../update-contexts';
import { Str, Int } from '@janus/vocabulary';
import type { BindingRecord } from '@janus/core';

function makeCtx(entity: string, id: string | null, record: Record<string, unknown>) {
  const binding: BindingRecord = {
    source: entity,
    component: () => {},
    view: id ? 'detail' : 'list',
    config: {
      fields: {
        title: { agent: 'read-write' as const },
        count: { agent: 'read' as const },
      },
    },
  };
  return createBindingContext(
    entity, id, id ? 'detail' : 'list', binding, record,
    { title: Str(), count: Int() },
  );
}

describe('updateBindingContexts', () => {
  test('updates committed and current for non-dirty fields', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original', count: 0 });

    updateBindingContexts([ctx], 'task', 'task-1', { title: 'Updated', count: 5 });

    expect(ctx.fields.title.committed.value).toBe('Updated');
    expect(ctx.fields.title.current.value).toBe('Updated');
    expect(ctx.fields.title.dirty.value).toBe(false);
    expect(ctx.fields.count.committed.value).toBe(5);
    expect(ctx.fields.count.current.value).toBe(5);
  });

  test('preserves dirty fields — only updates committed, not current', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original', count: 0 });

    // Simulate user edit
    ctx.fields.title.current.value = 'User Edit';
    expect(ctx.fields.title.dirty.value).toBe(true);

    // Server pushes an update
    updateBindingContexts([ctx], 'task', 'task-1', { title: 'Server Update', count: 10 });

    // committed updated, current preserved (user edit kept)
    expect(ctx.fields.title.committed.value).toBe('Server Update');
    expect(ctx.fields.title.current.value).toBe('User Edit');
    expect(ctx.fields.title.dirty.value).toBe(true);

    // Non-dirty field updated normally
    expect(ctx.fields.count.committed.value).toBe(10);
    expect(ctx.fields.count.current.value).toBe(10);
  });

  test('skips non-matching entity', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original' });

    updateBindingContexts([ctx], 'adr', 'adr-1', { title: 'Should not update' });

    expect(ctx.fields.title.committed.value).toBe('Original');
  });

  test('skips non-matching id', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original' });

    updateBindingContexts([ctx], 'task', 'task-2', { title: 'Should not update' });

    expect(ctx.fields.title.committed.value).toBe('Original');
  });

  test('skips fields not in the binding context', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original' });

    // Push with a field not in the binding
    updateBindingContexts([ctx], 'task', 'task-1', { title: 'Updated', unknown_field: 'ignored' });

    expect(ctx.fields.title.committed.value).toBe('Updated');
  });

  test('updates multiple matching contexts', () => {
    const ctx1 = makeCtx('task', 'task-1', { title: 'A' });
    const ctx2 = makeCtx('task', 'task-1', { title: 'A' });

    updateBindingContexts([ctx1, ctx2], 'task', 'task-1', { title: 'B' });

    expect(ctx1.fields.title.committed.value).toBe('B');
    expect(ctx2.fields.title.committed.value).toBe('B');
  });
});

describe('removeFromBindingContexts', () => {
  test('is a no-op for now (placeholder)', () => {
    const ctx = makeCtx('task', 'task-1', { title: 'Original' });

    // Should not throw
    removeFromBindingContexts([ctx], 'task', 'task-1');
    expect(ctx.fields.title.committed.value).toBe('Original');
  });
});
