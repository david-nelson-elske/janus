/**
 * Tests for route table derivation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import type { CompileResult } from '@janus/core';
import { registerHandlers } from '@janus/pipeline';
import { frameworkEntities, frameworkParticipations } from '@janus/pipeline';
import { Str, Lifecycle, Persistent } from '@janus/vocabulary';
import { deriveRouteTable } from '..';
import { apiSurface } from '..';

let registry: CompileResult;

beforeEach(() => {
  clearRegistry();
  registerHandlers();
});

afterEach(() => {
  clearRegistry();
});

function setup(options?: { lifecycle?: boolean }) {
  const schema: Record<string, any> = {
    title: Str({ required: true }),
  };
  if (options?.lifecycle) {
    schema.status = Lifecycle({ draft: ['published'], published: ['archived'] });
  }

  const note = define('note', { schema, storage: Persistent() });
  const noteP = participate(note, {});

  const surface = apiSurface();
  registry = compile(
    [note, noteP, ...frameworkEntities, ...frameworkParticipations],
    [surface.initiator],
  );
  return { surface };
}

describe('deriveRouteTable', () => {
  test('derives CRUD routes for a consumer entity', () => {
    const { surface } = setup();
    const routes = deriveRouteTable(registry, surface.initiator.name, '/api');

    expect(routes.length).toBeGreaterThanOrEqual(5);

    const methods = routes.map((r) => `${r.method} ${r.path}`);
    expect(methods).toContain('GET /api/notes');
    expect(methods).toContain('GET /api/notes/:id');
    expect(methods).toContain('POST /api/notes');
    expect(methods).toContain('PATCH /api/notes/:id');
    expect(methods).toContain('DELETE /api/notes/:id');
  });

  test('derives lifecycle transition routes', () => {
    const { surface } = setup({ lifecycle: true });
    const routes = deriveRouteTable(registry, surface.initiator.name, '/api');

    const methods = routes.map((r) => `${r.method} ${r.path}`);
    expect(methods).toContain('POST /api/notes/:id/published');
    expect(methods).toContain('POST /api/notes/:id/archived');
  });

  test('skips framework-origin entities', () => {
    const { surface } = setup();
    const routes = deriveRouteTable(registry, surface.initiator.name, '/api');

    const entities = new Set(routes.map((r) => r.entity));
    expect(entities.has('execution_log')).toBe(false);
  });

  test('respects custom basePath', () => {
    const { surface } = setup();
    const routes = deriveRouteTable(registry, surface.initiator.name, '/v2');

    const paths = routes.map((r) => r.path);
    expect(paths.every((p) => p.startsWith('/v2/'))).toBe(true);
  });

  test('strips trailing slash from basePath', () => {
    const { surface } = setup();
    const routes = deriveRouteTable(registry, surface.initiator.name, '/api/');

    const paths = routes.map((r) => r.path);
    expect(paths.some((p) => p.includes('//'))).toBe(false);
  });

  test('route entries have correct entity and operation', () => {
    const { surface } = setup();
    const routes = deriveRouteTable(registry, surface.initiator.name, '/api');

    const getList = routes.find((r) => r.method === 'GET' && r.path === '/api/notes');
    expect(getList?.entity).toBe('note');
    expect(getList?.operation).toBe('read');

    const post = routes.find((r) => r.method === 'POST' && r.path === '/api/notes');
    expect(post?.entity).toBe('note');
    expect(post?.operation).toBe('create');

    const del = routes.find((r) => r.method === 'DELETE');
    expect(del?.entity).toBe('note');
    expect(del?.operation).toBe('delete');
  });
});
