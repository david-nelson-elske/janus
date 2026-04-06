/**
 * Tests for the dispatch helper (createDispatchEntity, saveContext).
 */

import { describe, expect, test } from 'bun:test';
import { createBindingContext } from '../binding-context';
import { createDispatchEntity, saveContext } from '../dispatch-helper';
import { Str, Int } from '@janus/vocabulary';
import type { BindingRecord } from '@janus/core';

function makeCtx(record: Record<string, unknown>) {
  const binding: BindingRecord = {
    source: 'task',
    component: () => {},
    view: 'detail',
    config: {
      fields: {
        title: { agent: 'read-write' as const, component: 'heading' },
        status: { agent: 'read' as const, component: 'badge' },
        count: { agent: 'read-write' as const },
      },
    },
  };
  return createBindingContext(
    'task', 'task-1', 'detail', binding, record,
    { title: Str(), status: Str(), count: Int() },
  );
}

describe('createDispatchEntity', () => {
  test('creates a function that constructs correct URLs', async () => {
    let lastUrl = '';
    let lastMethod = '';

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      lastUrl = url;
      lastMethod = init?.method;
      return new Response(JSON.stringify({ ok: true, data: { id: '1', title: 'Created' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const dispatch = createDispatchEntity({ baseUrl: '/api' });

      await dispatch('task', 'create', { title: 'New' });
      expect(lastUrl).toBe('/api/tasks');
      expect(lastMethod).toBe('POST');

      await dispatch('task', 'update', { id: '1', title: 'Updated' });
      expect(lastUrl).toBe('/api/tasks/1');
      expect(lastMethod).toBe('PATCH');

      await dispatch('task', 'delete', { id: '1' });
      expect(lastUrl).toBe('/api/tasks/1');
      expect(lastMethod).toBe('DELETE');

      await dispatch('task', 'in_progress', { id: '1' });
      expect(lastUrl).toBe('/api/tasks/1/in_progress');
      expect(lastMethod).toBe('POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('includes auth header when auth function is provided', async () => {
    let lastHeaders: Record<string, string> = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init: any) => {
      lastHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const dispatch = createDispatchEntity({
        baseUrl: '/api',
        auth: () => 'my-token',
      });

      await dispatch('task', 'create', { title: 'Test' });
      expect(lastHeaders['X-API-Key']).toBe('my-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns error on network failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('Network error');
    };

    try {
      const dispatch = createDispatchEntity({ baseUrl: '/api' });
      const result = await dispatch('task', 'create', { title: 'Test' });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe('network');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('saveContext', () => {
  test('saves dirty read-write fields only', async () => {
    let savedInput: any = null;

    const dispatch = async (_e: string, _op: string, input: any) => {
      savedInput = input;
      return { ok: true, data: { id: 'task-1', title: input.title, status: 'pending', count: input.count ?? 0 } };
    };

    const ctx = makeCtx({ title: 'Original', status: 'pending', count: 0 });

    // Edit title and count (both read-write)
    ctx.fields.title.current.value = 'Edited Title';
    ctx.fields.count.current.value = 5;

    const result = await saveContext(ctx, dispatch);

    expect(result?.ok).toBe(true);
    expect(savedInput.title).toBe('Edited Title');
    expect(savedInput.count).toBe(5);
    // status is read-only, should not be in the patch
    expect(savedInput.status).toBeUndefined();
  });

  test('updates committed after successful save', async () => {
    const dispatch = async () => {
      return { ok: true, data: { id: 'task-1', title: 'Server Title' } };
    };

    const ctx = makeCtx({ title: 'Original' });
    ctx.fields.title.current.value = 'Edited';

    await saveContext(ctx, dispatch);

    expect(ctx.fields.title.committed.value).toBe('Server Title');
  });

  test('returns undefined when no dirty fields', async () => {
    let called = false;
    const dispatch = async () => {
      called = true;
      return { ok: true };
    };

    const ctx = makeCtx({ title: 'Clean' });
    const result = await saveContext(ctx, dispatch);

    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test('does not update committed on failed save', async () => {
    const dispatch = async () => {
      return { ok: false, error: { kind: 'validation-error', message: 'Bad input' } };
    };

    const ctx = makeCtx({ title: 'Original' });
    ctx.fields.title.current.value = 'Edited';

    const result = await saveContext(ctx, dispatch);

    expect(result?.ok).toBe(false);
    expect(ctx.fields.title.committed.value).toBe('Original');
    expect(ctx.fields.title.current.value).toBe('Edited');
  });
});
