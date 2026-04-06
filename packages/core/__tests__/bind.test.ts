import { afterEach, describe, expect, test } from 'bun:test';
import { define, bind, compile, seedHandlers, clearRegistry, participate } from '..';
import type { BindingRecord, ComponentType } from '..';
import { Str, Markdown, Lifecycle, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Helpers ─────────────────────────────────────────────────────

const DetailComponent: ComponentType = () => {};
const ListComponent: ComponentType = () => {};

function setup() {
  seedHandlers();

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Markdown(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    },
    storage: Persistent(),
  });

  return { note };
}

// ── bind() ─────────────────────────────────────────────────────

describe('bind()', () => {
  test('produces BindResult with kind "bind"', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    expect(result.kind).toBe('bind');
    expect(result.records).toHaveLength(1);
  });

  test('sets source from entity name', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    expect(result.records[0].source).toBe('note');
  });

  test('accepts string entity name', () => {
    setup();
    const result = bind('note', [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    expect(result.records[0].source).toBe('note');
  });

  test('preserves component reference', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    expect(result.records[0].component).toBe(DetailComponent);
  });

  test('preserves view name', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
      { component: ListComponent, view: 'list', config: {} },
    ]);
    expect(result.records[0].view).toBe('detail');
    expect(result.records[1].view).toBe('list');
  });

  test('preserves field binding config', () => {
    const { note } = setup();
    const result = bind(note, [
      {
        component: DetailComponent,
        view: 'detail',
        config: {
          fields: {
            title: { component: 'heading', agent: 'read-write', label: 'Title' },
            body: { component: 'richtext', agent: 'read-write' },
            status: { component: 'badge', agent: 'read' },
          },
          layout: 'single-column',
        },
      },
    ]);

    const config = result.records[0].config;
    expect(config.fields!.title.component).toBe('heading');
    expect(config.fields!.title.agent).toBe('read-write');
    expect(config.fields!.title.label).toBe('Title');
    expect(config.fields!.status.agent).toBe('read');
    expect(config.layout).toBe('single-column');
  });

  test('preserves columns config', () => {
    const { note } = setup();
    const result = bind(note, [
      {
        component: ListComponent,
        view: 'list',
        config: {
          columns: ['title', 'status'],
          fields: {
            title: { agent: 'read' },
            status: { agent: 'read' },
          },
        },
      },
    ]);

    expect(result.records[0].config.columns).toEqual(['title', 'status']);
  });

  test('result is frozen', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
    expect(Object.isFrozen(result.records[0].config)).toBe(true);
  });

  test('multiple bindings for same entity', () => {
    const { note } = setup();
    const result = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
      { component: ListComponent, view: 'list', config: {} },
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].view).toBe('detail');
    expect(result.records[1].view).toBe('list');
  });
});

// ── Binding index ──────────────────────────────────────────────

describe('compile() binding index', () => {
  test('bindingIndex is present on CompileResult', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    const result = compile([note, noteP, noteB]);
    expect(result.bindingIndex).toBeDefined();
  });

  test('byEntity returns bindings for entity', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
      { component: ListComponent, view: 'list', config: {} },
    ]);
    const result = compile([note, noteP, noteB]);
    const bindings = result.bindingIndex.byEntity('note');
    expect(bindings).toHaveLength(2);
  });

  test('byEntity returns empty for unknown entity', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const result = compile([note, noteP]);
    expect(result.bindingIndex.byEntity('unknown')).toHaveLength(0);
  });

  test('byView returns bindings for view', () => {
    const { note } = setup();
    const noteP = participate(note, {});

    const user = define('user', {
      schema: { name: Str({ required: true }) },
      storage: Persistent(),
    });
    const userP = participate(user, {});

    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    const userB = bind(user, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);

    const result = compile([note, user, noteP, userP, noteB, userB]);
    const details = result.bindingIndex.byView('detail');
    expect(details).toHaveLength(2);
  });

  test('byEntityAndView returns specific binding', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
      { component: ListComponent, view: 'list', config: {} },
    ]);
    const result = compile([note, noteP, noteB]);

    const detail = result.bindingIndex.byEntityAndView('note', 'detail');
    expect(detail).toBeDefined();
    expect(detail!.component).toBe(DetailComponent);
    expect(detail!.view).toBe('detail');

    const list = result.bindingIndex.byEntityAndView('note', 'list');
    expect(list).toBeDefined();
    expect(list!.component).toBe(ListComponent);
  });

  test('byEntityAndView returns undefined for missing pair', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const result = compile([note, noteP]);

    expect(result.bindingIndex.byEntityAndView('note', 'detail')).toBeUndefined();
  });

  test('bindings array on CompileResult is populated', () => {
    const { note } = setup();
    const noteP = participate(note, {});
    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    const result = compile([note, noteP, noteB]);
    expect(result.bindings).toHaveLength(1);
  });
});
