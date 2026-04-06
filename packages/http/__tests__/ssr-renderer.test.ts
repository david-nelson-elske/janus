/**
 * Tests for SSR renderer.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { h } from 'preact';
import { define, participate, bind, compile, clearRegistry, seedHandlers } from '@janus/core';
import { Str, Persistent } from '@janus/vocabulary';
import { createBindingContext } from '@janus/client';
import { renderPage } from '../ssr-renderer';

const SimpleList = ({ page }: any) => {
  const records = page?.records ?? [];
  return h('div', null,
    h('h1', null, 'Items'),
    ...records.map((r: any) => h('div', { key: r.id }, r.title)),
  );
};

const SimpleDetail = ({ context }: any) => {
  return h('div', null,
    h('h1', null, context?.fields?.title?.committed?.value ?? 'Untitled'),
  );
};

let registry: any;
let listBinding: any;
let detailBinding: any;

beforeEach(() => {
  clearRegistry();
  seedHandlers();

  const item = define('item', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
  });
  const itemP = participate(item, {});
  const itemB = bind(item, [
    {
      component: SimpleList as any,
      view: 'list',
      config: { fields: { title: { agent: 'read' as const } } },
    },
    {
      component: SimpleDetail as any,
      view: 'detail',
      config: { fields: { title: { agent: 'read-write' as const, component: 'heading' } } },
    },
  ]);

  registry = compile([item, itemP, itemB]);
  listBinding = registry.bindingIndex.byEntityAndView('item', 'list');
  detailBinding = registry.bindingIndex.byEntityAndView('item', 'detail');
});

describe('renderPage', () => {
  test('renders HTML document with DOCTYPE', () => {
    const ctx = createBindingContext(
      'item', null, 'list', listBinding,
      { title: 'Test' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: listBinding,
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  test('embeds window.__JANUS__ with serialized contexts', () => {
    const ctx = createBindingContext(
      'item', 'item-1', 'detail', detailBinding,
      { title: 'My Item' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: detailBinding,
    });

    expect(html).toContain('window.__JANUS__');
    const match = html.match(/window\.__JANUS__\s*=\s*({.*?});/s);
    expect(match).toBeTruthy();

    const initData = JSON.parse(match![1]);
    expect(initData.contexts).toHaveLength(1);
    expect(initData.contexts[0].entity).toBe('item');
    expect(initData.contexts[0].id).toBe('item-1');
    expect(initData.contexts[0].fields.title.value).toBe('My Item');
  });

  test('includes nav links for entities with bindings', () => {
    const ctx = createBindingContext(
      'item', null, 'list', listBinding,
      { title: 'Test' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: listBinding,
    });

    expect(html).toContain('Janus'); // nav brand
    expect(html).toContain('/items');  // nav link
  });

  test('renders component output in HTML', () => {
    const ctx = createBindingContext(
      'item', 'item-1', 'detail', detailBinding,
      { title: 'Hello World' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: detailBinding,
      title: 'Hello World',
    });

    expect(html).toContain('Hello World');
  });

  test('includes CSS styles', () => {
    const ctx = createBindingContext(
      'item', null, 'list', listBinding,
      { title: 'Test' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: listBinding,
    });

    expect(html).toContain('<style>');
    expect(html).toContain('.janus-nav');
    expect(html).toContain('.badge');
  });

  test('sets page title', () => {
    const ctx = createBindingContext(
      'item', 'item-1', 'detail', detailBinding,
      { title: 'Custom Title' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: detailBinding,
      title: 'Custom Title',
    });

    expect(html).toContain('<title>Custom Title</title>');
  });

  test('escapes title to prevent XSS', () => {
    const ctx = createBindingContext(
      'item', 'item-1', 'detail', detailBinding,
      { title: '<script>alert("xss")</script>' },
      { title: Str() },
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding: detailBinding,
      title: '<script>alert("xss")</script>',
    });

    expect(html).not.toContain('<title><script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
