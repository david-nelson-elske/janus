/**
 * Tests for ADR-124-12c consumer rendering hooks:
 *   1. theme — CSS, fonts, title, headExtras, lang overrides + APP_STYLES suppression
 *   2. layout — shell component override + suppressDefaultNav
 *   3. list-view query params — where.*, limit, offset, sort, search
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bind, clearRegistry, define, participate } from '@janus/core';
import { Int, Persistent, Str } from '@janus/vocabulary';
import { h } from 'preact';
import type { App } from '..';
import { createApp, parseListQueryParams } from '..';

// ── Minimal components ──────────────────────────────────────────

const TaskList = ({ page }: any) => {
  const records = page?.records ?? [];
  return h('div', { class: 'my-list' }, h('h1', null, `${records.length} tasks`));
};

const TaskDetail = ({ context }: any) =>
  h('div', { class: 'my-detail' }, context?.fields?.title?.committed?.value ?? 'n/a');

function defineTask() {
  return define('task', {
    schema: {
      title: Str({ required: true }),
      status: Str(),
      priority: Int(),
    },
    storage: Persistent(),
  });
}

function taskBindings(task: ReturnType<typeof defineTask>) {
  return bind(task, [
    { component: TaskList, view: 'list', config: {} },
    { component: TaskDetail, view: 'detail', config: {} },
  ]);
}

function taskDecls() {
  const task = defineTask();
  return [task, participate(task, {}), taskBindings(task)];
}

async function seed(app: App, rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    await app.dispatch('task', 'create', r);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Theme
// ═══════════════════════════════════════════════════════════════════

describe('theme hook', () => {
  let app: App;

  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('default: renders framework Inter fonts + APP_STYLES', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('fonts.googleapis.com');
    expect(html).toContain('Inter:'); // default Inter font
    expect(html).toContain('.janus-main'); // default APP_STYLES selector
    expect(html).toContain('<html lang="en">');
    // List views set their own title (entity plural); theme.title only takes effect
    // when renderPage is called without a `title` (e.g. consumer direct use).
    expect(html).toContain('<title>tasks</title>');
  });

  test('theme.title is appended to list-view title as site suffix', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: { title: 'Find My Next Bite' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    // page-handler composes `${entityTitle} — ${theme.title}` when theme.title is set
    expect(html).toContain('<title>tasks — Find My Next Bite</title>');
  });

  test('binding.config.title overrides the entity-plural default on list views', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      // The binding declares a human-friendlier page title than the
      // entity plural. Useful when the entity name is a noun but the
      // page-title should read as a section label (e.g. "milestone"
      // entity → "Timeline" page title).
      bind(task, [
        { component: TaskList, view: 'list', config: { title: 'Momentum' } },
        { component: TaskDetail, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({
      declarations: decls,
      http: { basePath: '/api' },
      theme: { title: 'My Site' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    // Per-binding title wins over the entity-plural default; theme.title
    // suffix still applies.
    expect(html).toContain('<title>Momentum — My Site</title>');
    expect(html).not.toContain('<title>tasks');
  });

  test('binding.config.title does NOT override detail pages when the record has a title', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: TaskList, view: 'list', config: { title: 'Momentum' } },
        { component: TaskDetail, view: 'detail', config: { title: 'Momentum' } },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    const created = await app.dispatch('task', 'create', { title: 'Real Task' });
    const taskId = (created.data as { id: string }).id;

    const res = await app.fetch(new Request(`http://localhost/tasks/${taskId}`));
    const html = await res.text();
    // Detail title prefers the record's own title/name over the binding
    // override — flattening every detail to one title would be unhelpful.
    expect(html).toContain('<title>Real Task</title>');
    expect(html).not.toContain('<title>Momentum');
  });

  test('theme.css suppresses APP_STYLES, keeps CSS_RESET', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: {
        css: '.custom-brand { color: #2D5016; }',
      },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('.custom-brand'); // consumer CSS present
    expect(html).toContain('box-sizing: border-box'); // CSS_RESET still present
    expect(html).not.toContain('.janus-main'); // APP_STYLES SUPPRESSED
    expect(html).not.toContain('.entity-row'); // APP_STYLES SUPPRESSED
  });

  test('theme.fonts replaces default font links', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: {
        fonts: {
          href: 'https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap',
          preconnect: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
        },
      },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('Playfair+Display');
    expect(html).not.toContain('Inter:'); // default replaced
  });

  test('theme.cssUrl emits external <link rel="stylesheet">', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: {
        cssUrl: '/assets/site.css',
      },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/site.css"');
  });

  test('theme.cssUrl accepts an array', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: { cssUrl: ['/a.css', '/b.css'] },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('href="/a.css"');
    expect(html).toContain('href="/b.css"');
  });

  test('theme.headExtras renders into <head> verbatim', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: {
        headExtras:
          '<link rel="icon" href="/favicon.svg"><meta name="theme-color" content="#2D5016">',
      },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('<link rel="icon" href="/favicon.svg">');
    expect(html).toContain('theme-color');
  });

  test('theme.lang sets <html lang>', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      theme: { lang: 'fr-CA' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('<html lang="fr-CA">');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Layout
// ═══════════════════════════════════════════════════════════════════

describe('layout hook', () => {
  let app: App;

  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('default: renders DefaultShell (nav + main)', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('class="janus-nav"');
    expect(html).toContain('class="janus-main"');
    expect(html).toContain('>Janus<'); // default brand
  });

  test('layout.suppressDefaultNav removes nav, keeps <main>', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      layout: { suppressDefaultNav: true },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).not.toContain('class="janus-nav"');
    expect(html).toContain('class="janus-main"');
  });

  test('layout.shell fully replaces the default wrapper', async () => {
    clearRegistry();
    const CustomShell = ({ children, path }: any) =>
      h(
        'div',
        { id: 'app', 'data-custom-shell': 'true' },
        h('header', { class: 'fmnb-nav' }, h('span', null, `path=${path}`)),
        h('main', { class: 'fmnb-main' }, children),
        h('footer', { class: 'fmnb-footer' }, '© 2026'),
      );

    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      layout: { shell: CustomShell },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('data-custom-shell="true"');
    expect(html).toContain('fmnb-nav');
    expect(html).toContain('fmnb-main');
    expect(html).toContain('fmnb-footer');
    expect(html).toContain('path=/tasks'); // path threaded into shell
    expect(html).not.toContain('class="janus-nav"'); // default nav NOT rendered
  });

  test('layout.shell receives registry for building custom nav', async () => {
    clearRegistry();
    const RegistryAwareShell = ({ children, registry }: any) => {
      const entities = Array.from(registry.graphNodes.keys()).filter(
        (n: any) => typeof n === 'string' && !n.startsWith('_'),
      );
      return h(
        'div',
        { id: 'app' },
        h('nav', { class: 'custom' }, `entities=${entities.join(',')}`),
        h('main', null, children),
      );
    };

    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
      layout: { shell: RegistryAwareShell },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('entities=');
    expect(html).toContain('task');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. List-view query params
// ═══════════════════════════════════════════════════════════════════

describe('parseListQueryParams', () => {
  test('empty params → empty object', () => {
    expect(parseListQueryParams(new URLSearchParams())).toEqual({});
  });

  test('limit + offset coerce to numbers', () => {
    const p = new URLSearchParams('limit=20&offset=40');
    expect(parseListQueryParams(p)).toEqual({ limit: 20, offset: 40 });
  });

  test('invalid limit silently ignored', () => {
    const p = new URLSearchParams('limit=abc');
    expect(parseListQueryParams(p)).toEqual({});
  });

  test('negative limit/offset silently ignored', () => {
    const p = new URLSearchParams('limit=-5&offset=-1');
    expect(parseListQueryParams(p)).toEqual({});
  });

  test('sort parses comma-separated, - prefix = desc', () => {
    const p = new URLSearchParams('sort=-createdAt,name');
    expect(parseListQueryParams(p)).toEqual({
      sort: [
        { field: 'createdAt', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ],
    });
  });

  test('search passes through as string', () => {
    const p = new URLSearchParams('search=ramen');
    expect(parseListQueryParams(p)).toEqual({ search: 'ramen' });
  });

  test('where.X=Y accumulates into where object', () => {
    const p = new URLSearchParams('where.status=published&where.facet=cuisine');
    expect(parseListQueryParams(p)).toEqual({
      where: { status: 'published', facet: 'cuisine' },
    });
  });

  test('where.flag=true coerces to boolean', () => {
    const p = new URLSearchParams('where.active=true&where.archived=false&where.deletedAt=null');
    expect(parseListQueryParams(p)).toEqual({
      where: { active: true, archived: false, deletedAt: null },
    });
  });

  test('unknown params are ignored', () => {
    const p = new URLSearchParams('fbclid=abc123&utm_source=twitter&limit=10');
    expect(parseListQueryParams(p)).toEqual({ limit: 10 });
  });

  test('empty where.* field name ignored', () => {
    const p = new URLSearchParams('where.=bad&where.x=good');
    expect(parseListQueryParams(p)).toEqual({ where: { x: 'good' } });
  });
});

describe('list query params reach dispatch', () => {
  let app: App;

  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('?where.status=done filters list dispatch results', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
    });
    await seed(app, [
      { title: 'pending A', status: 'pending' },
      { title: 'done B', status: 'done' },
      { title: 'done C', status: 'done' },
    ]);

    const res = await app.fetch(new Request('http://localhost/tasks?where.status=done'));
    const html = await res.text();
    expect(html).toContain('2 tasks'); // only done B + done C
  });

  test('?limit=1 caps returned records', async () => {
    clearRegistry();
    app = await createApp({
      declarations: taskDecls(),
      http: { basePath: '/api' },
    });
    await seed(app, [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);

    const res = await app.fetch(new Request('http://localhost/tasks?limit=1'));
    const html = await res.text();
    expect(html).toContain('1 tasks');
  });
});
