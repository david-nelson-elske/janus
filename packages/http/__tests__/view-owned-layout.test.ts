/**
 * Tests for ADR-124-12e view-owned layout (`renderMode: 'full-page'`):
 *   - full-page mode skips the shell wrap (no .janus-nav, no .janus-main)
 *   - default / 'shell' preserves pre-12e behavior
 *   - full-page component receives path, identity, registry as props
 *   - full-page composes with loader (12d) — component gets data + chrome props
 *   - document template (head, fonts, theme) still wraps full-page output
 *   - full-page bypasses consumer layout.shell too
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

async function seed(app: App, rows: Array<Record<string, unknown>>) {
  const ids: string[] = [];
  for (const r of rows) {
    const res = await app.dispatch('task', 'create', r);
    ids.push((res.data as { id: string }).id);
  }
  return ids;
}

// A full-page component that renders its own chrome and asserts
// presence of the props the framework is supposed to pass.
const FullPageTaskList = ({ path, identity, page }: any) =>
  h('div', { id: 'custom-app', 'data-path': path, 'data-identity': identity?.id ?? 'none' },
    h('header', { class: 'my-nav' }, 'Custom Nav'),
    h('aside', { class: 'my-rail' }, `path=${path}`),
    h('main', { class: 'my-main' }, `records=${(page?.records ?? []).length}`),
    h('footer', { class: 'my-footer' }, 'Custom Footer'),
  );

// ═══════════════════════════════════════════════════════════════════
// 1. renderMode: 'full-page' skips the shell
// ═══════════════════════════════════════════════════════════════════

describe('renderMode: full-page', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('full-page mode skips default shell (no .janus-nav, no .janus-main)', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: FullPageTaskList,
          view: 'list',
          config: { renderMode: 'full-page' },
        },
        { component: FullPageTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }, { title: 'B' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    // Custom chrome present
    expect(html).toContain('id="custom-app"');
    expect(html).toContain('class="my-nav"');
    expect(html).toContain('class="my-main"');
    expect(html).toContain('class="my-footer"');
    // Default shell absent
    expect(html).not.toContain('class="janus-nav"');
    expect(html).not.toContain('class="janus-main"');
  });

  test('default (no renderMode) preserves pre-12e behavior', async () => {
    clearRegistry();
    const ShellTaskList = ({ page }: any) =>
      h('div', { class: 'shell-list' }, `${(page?.records ?? []).length} tasks`);
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: ShellTaskList, view: 'list', config: {} },
        { component: ShellTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    // Default shell present
    expect(html).toContain('class="janus-nav"');
    expect(html).toContain('class="janus-main"');
    // Custom component content inside the shell
    expect(html).toContain('class="shell-list"');
  });

  test("explicit renderMode: 'shell' is equivalent to omitting it", async () => {
    clearRegistry();
    const ShellTaskList = ({ page }: any) =>
      h('div', { class: 'shell-list' }, `${(page?.records ?? []).length} tasks`);
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        { component: ShellTaskList, view: 'list', config: { renderMode: 'shell' } },
        { component: ShellTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('class="janus-nav"');
    expect(html).toContain('class="janus-main"');
    expect(html).toContain('class="shell-list"');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Props passed to the full-page component
// ═══════════════════════════════════════════════════════════════════

describe('full-page component props', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('component receives path + identity + registry', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: FullPageTaskList,
          view: 'list',
          config: { renderMode: 'full-page' },
        },
        { component: FullPageTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('data-path="/tasks"');
    expect(html).toContain('data-identity="anonymous"');
    expect(html).toContain('path=/tasks'); // echoed from aside
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Document template still wraps full-page output
// ═══════════════════════════════════════════════════════════════════

describe('document template with full-page', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('theme + fonts + CSS_RESET still wrap the custom body', async () => {
    clearRegistry();
    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: FullPageTaskList,
          view: 'list',
          config: { renderMode: 'full-page' },
        },
        { component: FullPageTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({
      declarations: decls,
      http: { basePath: '/api' },
      theme: { title: 'Full-page Site', css: '.brand { color: #ffeb3b; }' },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>tasks — Full-page Site</title>');
    expect(html).toContain('.brand { color: #ffeb3b; }');
    expect(html).toContain('box-sizing: border-box'); // CSS_RESET
    expect(html).toContain('window.__JANUS__'); // hydration blob
    // But no shell, because renderMode: 'full-page'
    expect(html).not.toContain('class="janus-nav"');
  });

  test('consumer-provided layout.shell is also bypassed by full-page', async () => {
    clearRegistry();
    const CustomShell = ({ children }: any) =>
      h('div', { id: 'consumer-shell' }, children);

    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: FullPageTaskList,
          view: 'list',
          config: { renderMode: 'full-page' },
        },
        { component: FullPageTaskList, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({
      declarations: decls,
      http: { basePath: '/api' },
      layout: { shell: CustomShell },
    });
    await seed(app, [{ title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    // Consumer shell NOT used — full-page wins at binding level
    expect(html).not.toContain('id="consumer-shell"');
    // Component's own chrome IS rendered
    expect(html).toContain('id="custom-app"');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Composition with loader (ADR-124-12d)
// ═══════════════════════════════════════════════════════════════════

describe('full-page + loader', () => {
  let app: App;
  afterEach(async () => {
    if (app) await app.shutdown();
    clearRegistry();
  });

  test('loader result reaches full-page component as `data` alongside chrome props', async () => {
    clearRegistry();
    const Composed = ({ data, path, identity }: any) =>
      h('div', { id: 'composed' },
        h('header', { 'data-path': path, 'data-id': identity?.id ?? 'n/a' }),
        h('main', null, `titles=${(data?.titles ?? []).join(',')}`),
      );

    const task = defineTask();
    const decls = [
      task,
      participate(task, {}),
      bind(task, [
        {
          component: Composed,
          view: 'list',
          config: {
            renderMode: 'full-page',
            loader: async (ctx) => {
              const page = (await ctx.read('task')) as { records: { title: string }[] };
              return { titles: page.records.map((r) => r.title).sort() };
            },
          },
        },
        { component: Composed, view: 'detail', config: {} },
      ]),
    ];
    app = await createApp({ declarations: decls, http: { basePath: '/api' } });
    await seed(app, [{ title: 'B' }, { title: 'A' }]);

    const res = await app.fetch(new Request('http://localhost/tasks'));
    const html = await res.text();
    expect(html).toContain('id="composed"');
    expect(html).toContain('data-path="/tasks"');
    expect(html).toContain('titles=A,B');
    expect(html).not.toContain('class="janus-nav"');
  });
});
