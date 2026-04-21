/**
 * Tests for ADR-124-12d binding loaders:
 *   - loader output flows to the component as the `data` prop
 *   - no loader preserves pre-12d default read behavior
 *   - loader receives params / identity / url / request
 *   - loader throws → error page rendered
 *   - ctx.read threads identity through the dispatch pipeline
 *     (policy concern cannot be bypassed)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { bind, clearRegistry, define, participate } from '@janus/core';
import { Persistent, Str } from '@janus/vocabulary';
import { h } from 'preact';
import type { App } from '..';
import { createApp } from '..';

// ── Fixtures ───────────────────────────────────────────────────────

function defineTask() {
  return define('task', {
    schema: { title: Str({ required: true }), status: Str() },
    storage: Persistent(),
  });
}

/** Echoes loader data as JSON on a data attribute — easy to assert against. */
const LoaderEcho = ({ data }: any) =>
  h('div', { class: 'loader-echo', 'data-payload': JSON.stringify(data ?? null) });

const DefaultDetail = ({ context }: any) =>
  h('div', { class: 'default-detail' }, context?.fields?.title?.committed?.value ?? 'n/a');

const DefaultList = ({ page }: any) =>
  h('div', { class: 'default-list' }, `${(page?.records ?? []).length} tasks`);

async function seed(app: App, rows: Array<Record<string, unknown>>) {
  const ids: string[] = [];
  for (const r of rows) {
    const res = await app.dispatch('task', 'create', r);
    ids.push((res.data as { id: string }).id);
  }
  return ids;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Loader output reaches the component
// ═══════════════════════════════════════════════════════════════════

describe('binding loader — detail view', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('loader output reaches component as `data` prop', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'detail',
          config: {
            loader: async (ctx) => ({
              greeting: `hello ${ctx.params.id}`,
              count: 42,
            }),
          },
        },
        { component: DefaultList, view: 'list', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    const [id] = await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request(`http://localhost/tasks/${id}`));
    const html = await res.text();
    expect(html).toContain('class="loader-echo"');
    expect(html).toContain(`&quot;greeting&quot;:&quot;hello ${id}&quot;`);
    expect(html).toContain('&quot;count&quot;:42');
  });

  test('loader receives route params.id', async () => {
    clearRegistry();
    let capturedId: string | undefined;
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'detail',
          config: {
            loader: async (ctx) => {
              capturedId = ctx.params.id;
              return {};
            },
          },
        },
        { component: DefaultList, view: 'list', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    const [id] = await seed(app, [{ title: 'A' }]);

    await app.fetch(new Request(`http://localhost/tasks/${id}`));
    expect(capturedId).toBe(id);
  });

  test('no loader preserves pre-12d default read path', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: DefaultDetail, view: 'detail', config: {} },
        { component: DefaultList, view: 'list', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    const [id] = await seed(app, [{ title: 'Preserved' }]);

    const res = await app.fetch(new Request(`http://localhost/tasks/${id}`));
    const html = await res.text();
    expect(html).toContain('class="default-detail"');
    expect(html).toContain('Preserved');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. List views
// ═══════════════════════════════════════════════════════════════════

describe('binding loader — list view', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('loader can compose via ctx.read; default filtered read is skipped', async () => {
    clearRegistry();
    let loaderInvocations = 0;
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            loader: async (ctx) => {
              loaderInvocations++;
              const page = (await ctx.read('task')) as {
                records: readonly { title: string }[];
              };
              return { titles: page.records.map((r) => r.title) };
            },
          },
        },
        { component: DefaultDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }, { title: 'B' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(loaderInvocations).toBe(1);
    // Read order isn't guaranteed — just confirm both titles landed in the payload.
    expect(html).toContain('&quot;A&quot;');
    expect(html).toContain('&quot;B&quot;');
    expect(html).toContain('&quot;titles&quot;');
  });

  test('loader has empty params for list views', async () => {
    clearRegistry();
    let capturedParams: { id?: string } | undefined;
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            loader: async (ctx) => {
              capturedParams = { ...ctx.params };
              return {};
            },
          },
        },
        { component: DefaultDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    await app.fetch(new Request('http://localhost/tasks'));
    expect(capturedParams).toEqual({});
  });

  test('loader receives url so it can read custom query params', async () => {
    clearRegistry();
    let capturedFocus: string | null | undefined;
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            loader: async (ctx) => {
              capturedFocus = ctx.url.searchParams.get('focus');
              return {};
            },
          },
        },
        { component: DefaultDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    await app.fetch(new Request('http://localhost/tasks?focus=prioritize'));
    expect(capturedFocus).toBe('prioritize');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Errors
// ═══════════════════════════════════════════════════════════════════

describe('binding loader — errors', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('loader throw → 500 error page includes the error message', async () => {
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
            loader: async () => {
              throw new Error('kaput');
            },
          },
        },
        { component: DefaultDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('kaput');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Authorization — ctx.read cannot bypass the policy concern
// ═══════════════════════════════════════════════════════════════════

describe('binding loader — authorization', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('ctx.read on policy-restricted entity surfaces dispatch denial', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      // Anonymous reads blocked. The loader has no identity (no session
      // cookie on the test request → identity is ANONYMOUS), so ctx.read
      // hits the policy concern, which throws, which surfaces as an error
      // page. This proves the loader does not sneak past the pipeline.
      participate(task, {
        policy: {
          rules: [{ role: 'admin', operations: '*' }],
          anonymousRead: false,
        },
      }),
      bind(task, [
        {
          component: LoaderEcho,
          view: 'list',
          config: {
            loader: async (ctx) => {
              return await ctx.read('task');
            },
          },
        },
        { component: DefaultDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });

    const res = await app.fetch(new Request('http://localhost/tasks'));
    expect(res.status).toBe(500);
    const html = await res.text();
    // policy-lookup throws `Anonymous access denied for task:read`
    expect(html).toContain('Anonymous access denied');
  });
});
