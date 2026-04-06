/**
 * Tests for derived storage adapter.
 *
 * Exercises: simple derived (from/where), computed derived (function),
 * read-only enforcement, agent tool discovery integration.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  clearRegistry,
  SYSTEM,
} from '@janus/core';
import type { ReadPage, EntityRecord } from '@janus/core';
import { Str, Int, Enum, Lifecycle, Persistent, Derived } from '@janus/vocabulary';
import { createTestHarness } from '../../testing';
import type { TestHarness } from '../../testing';

afterEach(() => clearRegistry());

// ── Simple derived (from/where) ────────────────────────────────

describe('simple derived entity', () => {
  async function setup() {
    const task = define('task', {
      schema: {
        title: Str({ required: true }),
        priority: Enum(['low', 'medium', 'high']),
        status: Lifecycle({
          pending: ['in_progress', 'completed'],
          in_progress: ['completed'],
        }),
      },
      storage: Persistent(),
    });

    const pending_tasks = define('pending_tasks', {
      schema: {
        title: Str({ required: true }),
        priority: Enum(['low', 'medium', 'high']),
        status: Lifecycle({
          pending: ['in_progress', 'completed'],
          in_progress: ['completed'],
        }),
      },
      storage: Derived({ from: 'task', where: { status: 'pending' } }),
      description: 'Tasks that are still pending',
    });

    const h = await createTestHarness({
      declarations: [
        task, pending_tasks,
        participate(task, {}),
        participate(pending_tasks, {}),
      ],
    });

    return h;
  }

  test('reads only records matching the static filter', async () => {
    const h = await setup();

    await h.dispatch('task', 'create', { title: 'Task 1', priority: 'high' });
    await h.dispatch('task', 'create', { title: 'Task 2', priority: 'low' });

    // Both tasks are pending by default (lifecycle initial state)
    const resp = await h.dispatch('pending_tasks', 'read', {});
    expect(resp.ok).toBe(true);
    const page = resp.data as ReadPage;
    expect(page.records).toHaveLength(2);

    // Transition one to in_progress
    const taskResp = await h.dispatch('task', 'read', {});
    const taskId = (taskResp.data as ReadPage).records[0].id;
    await h.dispatch('task', 'update', { id: taskId, status: 'in_progress' });

    // Now only 1 pending
    const resp2 = await h.dispatch('pending_tasks', 'read', {});
    expect((resp2.data as ReadPage).records).toHaveLength(1);

    h.teardown();
  });

  test('additional where clause narrows further', async () => {
    const h = await setup();

    await h.dispatch('task', 'create', { title: 'High', priority: 'high' });
    await h.dispatch('task', 'create', { title: 'Low', priority: 'low' });

    const resp = await h.dispatch('pending_tasks', 'read', { where: { priority: 'high' } });
    expect(resp.ok).toBe(true);
    expect((resp.data as ReadPage).records).toHaveLength(1);
    expect((resp.data as ReadPage).records[0].title).toBe('High');

    h.teardown();
  });

  test('read by id verifies record matches filter', async () => {
    const h = await setup();

    const r1 = await h.dispatch('task', 'create', { title: 'Task 1' });
    const taskId = (r1.data as { id: string }).id;

    // Read by id via derived — should work (task is pending)
    const resp = await h.dispatch('pending_tasks', 'read', { id: taskId });
    expect(resp.ok).toBe(true);

    // Transition away from pending
    await h.dispatch('task', 'update', { id: taskId, status: 'in_progress' });

    // Now reading by id via derived should fail (not pending anymore)
    const resp2 = await h.dispatch('pending_tasks', 'read', { id: taskId });
    expect(resp2.ok).toBe(false);

    h.teardown();
  });
});

// ── Computed derived (function) ────────────────────────────────

describe('computed derived entity', () => {
  test('compute function returns records on read', async () => {
    let callCount = 0;

    const stats = define('stats', {
      schema: {
        label: Str({ required: true }),
        value: Int({ required: true }),
      },
      storage: Derived({
        compute: async () => {
          callCount++;
          return [
            { id: '_s:1', _version: 1, createdAt: '', createdBy: 'system', updatedAt: '', updatedBy: 'system', label: 'total', value: 42 },
            { id: '_s:2', _version: 1, createdAt: '', createdBy: 'system', updatedAt: '', updatedBy: 'system', label: 'active', value: 10 },
          ];
        },
      }),
      description: 'Computed stats',
    });

    const h = await createTestHarness({
      declarations: [stats, participate(stats, {})],
    });

    const resp = await h.dispatch('stats', 'read', {});
    expect(resp.ok).toBe(true);
    const page = resp.data as ReadPage;
    expect(page.records).toHaveLength(2);
    expect(page.records[0].label).toBe('total');
    expect(page.records[0].value).toBe(42);
    expect(callCount).toBe(1);

    // Read again — compute is called again (no caching by default)
    await h.dispatch('stats', 'read', {});
    expect(callCount).toBe(2);

    h.teardown();
  });
});

// ── Read-only enforcement ──────────────────────────────────────

describe('read-only enforcement', () => {
  test('create on derived entity fails', async () => {
    const view = define('view_entity', {
      schema: { name: Str() },
      storage: Derived({ compute: async () => [] }),
    });

    const h = await createTestHarness({
      declarations: [view, participate(view, {})],
    });

    // Derived entities only have 'read' operation — create should fail
    const resp = await h.dispatch('view_entity', 'create', { name: 'test' });
    expect(resp.ok).toBe(false);

    h.teardown();
  });
});

// ── Operations derived from storage strategy ───────────────────

describe('derived entity operations', () => {
  test('derived entity only has read operation', async () => {
    const view = define('view_entity', {
      schema: { name: Str() },
      storage: Derived({ compute: async () => [] }),
    });

    const h = await createTestHarness({
      declarations: [view, participate(view, {})],
    });

    const entity = h.registry.entity('view_entity');
    expect(entity).toBeDefined();
    expect(entity!.operations).toEqual(['read']);

    h.teardown();
  });
});

// ── Agent tool discovery ───────────────────────────────────────

describe('agent tool discovery', () => {
  test('derived entities appear as read-only tools', async () => {
    const { discoverTools } = await import('../../agent');
    const { agentSurface } = await import('../../agent');

    const task = define('task', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const summary = define('task_stats', {
      schema: { total: Int(), done: Int() },
      storage: Derived({ compute: async () => [] }),
      description: 'Task statistics',
    });

    const surface = agentSurface();

    const h = await createTestHarness({
      declarations: [
        task, summary,
        participate(task, {}), participate(summary, {}),
      ],
      initiators: [surface.initiator],
    });

    const tools = discoverTools(h.registry, 'agent-surface');
    const summaryTools = tools.filter((t) => t.entity === 'task_stats');
    expect(summaryTools).toHaveLength(1);
    expect(summaryTools[0].operation).toBe('read');
    expect(summaryTools[0].description).toBe('Task statistics');

    h.teardown();
  });
});
