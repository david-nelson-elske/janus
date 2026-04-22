/**
 * Tests for ADR-124-12f binding route policy (`config.require`):
 *   - require returns true → proceeds to loader / default read
 *   - require returns false → 403 forbidden page
 *   - require returns { redirect } → 302 to the given URL
 *   - no require → pre-12f behavior preserved
 *   - require fires BEFORE the loader (loader never called when denied)
 *   - async require works; receives identity + params + url
 *   - require can use ctx.read to consult the dispatch pipeline
 *   - require throwing renders a 500 (not an implicit allow)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { bind, clearRegistry, define, participate } from '@janus/core';
import { Persistent, Str } from '@janus/vocabulary';
import { h } from 'preact';
import type { App } from '..';
import { createApp } from '..';

function defineTask() {
  return define('task', {
    schema: { title: Str({ required: true }), status: Str() },
    storage: Persistent(),
  });
}

const LoaderEcho = ({ data, page }: any) => {
  if (data !== undefined) {
    return h('div', { class: 'loader-echo', 'data-payload': JSON.stringify(data) });
  }
  return h('div', { class: 'default-list' }, `${(page?.records ?? []).length} tasks`);
};

async function seed(app: App, rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    await app.dispatch('task', 'create', r);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Happy path: require returns true
// ═══════════════════════════════════════════════════════════════════

describe('require: allow', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('require returns true → loader runs, renders normally', async () => {
    clearRegistry();
    const task = defineTask();
    let loaderRan = 0;
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            require: () => true,
            loader: async () => {
              loaderRan++;
              return { ok: true };
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="loader-echo"');
    expect(loaderRan).toBe(1);
  });

  test('no require → pre-12f behavior preserved (default read runs)', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: LoaderEcho, view: 'list', config: {} },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }, { title: 'B' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('2 tasks');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Deny: require returns false
// ═══════════════════════════════════════════════════════════════════

describe('require: deny', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('require returns false → 403 forbidden page; loader not invoked', async () => {
    clearRegistry();
    const task = defineTask();
    let loaderRan = 0;
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            require: () => false,
            loader: async () => {
              loaderRan++;
              return { ok: true };
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Forbidden');
    expect(loaderRan).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Redirect
// ═══════════════════════════════════════════════════════════════════

describe('require: redirect', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('require returns { redirect } → 302 to given URL; loader not invoked', async () => {
    clearRegistry();
    const task = defineTask();
    let loaderRan = 0;
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            require: () => ({ redirect: '/activate' }),
            loader: async () => {
              loaderRan++;
              return { ok: true };
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    // app.fetch returns the Response as-is; it never follows redirects.
    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/activate');
    expect(loaderRan).toBe(0);
  });

  test('common pattern: anonymous → login redirect', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            require: (ctx) => {
              if (ctx.identity.id === 'anonymous') {
                return { redirect: '/login' };
              }
              return true;
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Context + async
// ═══════════════════════════════════════════════════════════════════

describe('require: context', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('require receives identity + url + params; async works', async () => {
    clearRegistry();
    let captured: { identityId?: string; path?: string; paramId?: string } = {};
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: LoaderEcho, view: 'list', config: {} },
        {
          component: LoaderEcho,
          view: 'detail',
          config: {
            require: async (ctx) => {
              captured = {
                identityId: ctx.identity.id,
                path: ctx.url.pathname,
                paramId: ctx.params.id,
              };
              return true;
            },
          },
        },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    const created = await app.dispatch('task', 'create', { title: 'X' });
    const taskId = (created.data as { id: string }).id;

    await app.fetch(new Request(`http://localhost/tasks/${taskId}`));
    expect(captured.identityId).toBe('anonymous');
    expect(captured.path).toBe(`/tasks/${taskId}`);
    expect(captured.paramId).toBe(taskId);
  });

  test('require can call ctx.read to consult the dispatch pipeline', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            // Allow iff at least 2 tasks exist (arbitrary, proves ctx.read works).
            require: async (ctx) => {
              const page = (await ctx.read('task')) as { records: readonly unknown[] };
              return page.records.length >= 2;
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'only-one' }]);

    const denied = await app.fetch(new Request('http://localhost/tasks'));
    expect(denied.status).toBe(403);

    await seed(app, [{ title: 'now-two' }]);
    const allowed = await app.fetch(new Request('http://localhost/tasks'));
    expect(allowed.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Errors
// ═══════════════════════════════════════════════════════════════════

describe('require: errors', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('require throws → 500 (not treated as an implicit allow)', async () => {
    clearRegistry();
    const task = defineTask();
    let loaderRan = 0;
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            require: () => {
              throw new Error('policy kaput');
            },
            loader: async () => {
              loaderRan++;
              return { ok: true };
            },
          },
        },
        { component: LoaderEcho, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('policy kaput');
    expect(loaderRan).toBe(0);
  });
});
