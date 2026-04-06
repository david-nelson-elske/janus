/**
 * Tests for page router — URL → entity + view resolution.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { define, participate, bind, compile, clearRegistry, seedHandlers } from '@janus/core';
import { Str, Persistent } from '@janus/vocabulary';
import type { CompileResult } from '@janus/core';
import { resolvePageRoute, buildNavLinks } from '../page-router';

let registry: CompileResult;

beforeEach(() => {
  clearRegistry();
  seedHandlers();

  const task = define('task', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const taskP = participate(task, {});

  const adr = define('adr', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const adrP = participate(adr, {});

  const taskBind = bind(task, [
    { component: () => {}, view: 'list', config: { fields: { title: { agent: 'read' as const } } } },
    { component: () => {}, view: 'detail', config: { fields: { title: { agent: 'read-write' as const } } } },
  ]);

  const adrBind = bind(adr, [
    { component: () => {}, view: 'list', config: { fields: { title: { agent: 'read' as const } } } },
    { component: () => {}, view: 'detail', config: { fields: { title: { agent: 'read-write' as const } } } },
  ]);

  registry = compile([task, taskP, adr, adrP, taskBind, adrBind]);
});

describe('resolvePageRoute', () => {
  test('/ resolves to first entity with list binding', () => {
    const route = resolvePageRoute('/', registry);
    expect(route).toBeDefined();
    expect(route!.view).toBe('list');
    expect(route!.id).toBeNull();
  });

  test('/tasks resolves to task list', () => {
    const route = resolvePageRoute('/tasks', registry);
    expect(route).toEqual({ entity: 'task', view: 'list', id: null });
  });

  test('/tasks/abc resolves to task detail', () => {
    const route = resolvePageRoute('/tasks/abc', registry);
    expect(route).toEqual({ entity: 'task', view: 'detail', id: 'abc' });
  });

  test('/adrs resolves to adr list', () => {
    const route = resolvePageRoute('/adrs', registry);
    expect(route).toEqual({ entity: 'adr', view: 'list', id: null });
  });

  test('/adrs/xyz resolves to adr detail', () => {
    const route = resolvePageRoute('/adrs/xyz', registry);
    expect(route).toEqual({ entity: 'adr', view: 'detail', id: 'xyz' });
  });

  test('/unknown returns undefined', () => {
    expect(resolvePageRoute('/unknown', registry)).toBeUndefined();
  });

  test('/execution_logs returns undefined (framework entity)', () => {
    expect(resolvePageRoute('/execution_logs', registry)).toBeUndefined();
  });
});

describe('buildNavLinks', () => {
  test('returns links for entities with list bindings', () => {
    const links = buildNavLinks(registry);
    expect(links.length).toBeGreaterThanOrEqual(2);
    const entities = links.map((l) => l.entity);
    expect(entities).toContain('task');
    expect(entities).toContain('adr');
  });

  test('links have correct href format', () => {
    const links = buildNavLinks(registry);
    const taskLink = links.find((l) => l.entity === 'task')!;
    expect(taskLink.href).toBe('/tasks');
  });
});
