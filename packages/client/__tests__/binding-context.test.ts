import { afterEach, describe, expect, test } from 'bun:test';
import { createBindingContext, createBindingContextFromRegistry } from '..';
import { define, participate, bind, compile, seedHandlers, clearRegistry } from '@janus/core';
import type { BindingRecord, SchemaField, ComponentType } from '@janus/core';
import { Str, Markdown, Lifecycle, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

const DetailComponent: ComponentType = () => {};

function makeBinding(fields: Record<string, { component?: string; agent: 'read-write' | 'read' | 'aware'; label?: string }>): BindingRecord {
  return {
    source: 'note',
    component: DetailComponent,
    view: 'detail',
    config: { fields },
  };
}

const noteSchema: Record<string, SchemaField> = {
  title: Str({ required: true }),
  body: Markdown(),
  status: Lifecycle({ draft: ['published'], published: ['archived'] }),
};

describe('createBindingContext()', () => {
  test('creates context with entity, id, and view', () => {
    const binding = makeBinding({ title: { agent: 'read-write' } });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, { title: 'Hello' }, noteSchema);
    expect(ctx.entity).toBe('note');
    expect(ctx.id).toBe('note-1');
    expect(ctx.view).toBe('detail');
  });

  test('id can be null for collection views', () => {
    const binding = makeBinding({ title: { agent: 'read' } });
    const ctx = createBindingContext('note', null, 'list', binding, { title: 'Hello' }, noteSchema);
    expect(ctx.id).toBeNull();
  });

  test('creates field states from binding config', () => {
    const binding = makeBinding({
      title: { component: 'heading', agent: 'read-write', label: 'Title' },
      body: { component: 'richtext', agent: 'read-write' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      body: '# Content',
    }, noteSchema);

    expect(Object.keys(ctx.fields)).toEqual(['title', 'body']);
    expect(ctx.fields.title.current.value).toBe('Hello');
    expect(ctx.fields.body.current.value).toBe('# Content');
  });

  test('resolves field meta from schema and binding config', () => {
    const binding = makeBinding({
      title: { component: 'heading', agent: 'read-write', label: 'Title' },
      status: { component: 'badge', agent: 'read' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      status: 'draft',
    }, noteSchema);

    expect(ctx.fields.title.meta.type).toBe('str');
    expect(ctx.fields.title.meta.agent).toBe('read-write');
    expect(ctx.fields.title.meta.component).toBe('heading');
    expect(ctx.fields.title.meta.label).toBe('Title');

    expect(ctx.fields.status.meta.type).toBe('lifecycle');
    expect(ctx.fields.status.meta.agent).toBe('read');
    expect(ctx.fields.status.meta.component).toBe('badge');
  });

  test('excludes fields not in binding config', () => {
    const binding = makeBinding({
      title: { agent: 'read' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      body: '# Content',
      status: 'draft',
    }, noteSchema);

    expect(Object.keys(ctx.fields)).toEqual(['title']);
    expect(ctx.fields.body).toBeUndefined();
    expect(ctx.fields.status).toBeUndefined();
  });

  test('uses null for missing record values', () => {
    const binding = makeBinding({
      title: { agent: 'read-write' },
      body: { agent: 'read-write' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      // body not present
    }, noteSchema);

    expect(ctx.fields.title.current.value).toBe('Hello');
    expect(ctx.fields.body.current.value).toBeNull();
  });

  test('dirty is false when no fields have changed', () => {
    const binding = makeBinding({
      title: { agent: 'read-write' },
      body: { agent: 'read-write' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      body: '# Content',
    }, noteSchema);

    expect(ctx.dirty.value).toBe(false);
  });

  test('dirty becomes true when any field changes', () => {
    const binding = makeBinding({
      title: { agent: 'read-write' },
      body: { agent: 'read-write' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      body: '# Content',
    }, noteSchema);

    ctx.fields.title.current.value = 'Updated';
    expect(ctx.dirty.value).toBe(true);
  });

  test('dirty reverts when all fields revert', () => {
    const binding = makeBinding({
      title: { agent: 'read-write' },
      body: { agent: 'read-write' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {
      title: 'Hello',
      body: '# Content',
    }, noteSchema);

    ctx.fields.title.current.value = 'Updated';
    expect(ctx.dirty.value).toBe(true);
    ctx.fields.title.current.value = 'Hello';
    expect(ctx.dirty.value).toBe(false);
  });

  test('context is frozen', () => {
    const binding = makeBinding({ title: { agent: 'read' } });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, { title: 'Hello' }, noteSchema);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.fields)).toBe(true);
  });

  test('handles empty binding config fields', () => {
    const binding: BindingRecord = {
      source: 'note',
      component: DetailComponent,
      view: 'detail',
      config: {},
    };
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, { title: 'Hello' }, noteSchema);
    expect(Object.keys(ctx.fields)).toHaveLength(0);
    expect(ctx.dirty.value).toBe(false);
  });

  test('uses "unknown" type for fields not in schema', () => {
    const binding = makeBinding({
      missing: { agent: 'read' },
    });
    const ctx = createBindingContext('note', 'note-1', 'detail', binding, {}, noteSchema);
    expect(ctx.fields.missing.meta.type).toBe('unknown');
  });
});

// ── createBindingContextFromRegistry ───────────────────────────

describe('createBindingContextFromRegistry()', () => {
  test('looks up binding and schema from registry', () => {
    seedHandlers();
    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        body: Markdown(),
        status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteB = bind(note, [
      {
        component: DetailComponent,
        view: 'detail',
        config: {
          fields: {
            title: { component: 'heading', agent: 'read-write', label: 'Title' },
            status: { component: 'badge', agent: 'read' },
          },
        },
      },
    ]);
    const registry = compile([note, noteP, noteB]);

    const ctx = createBindingContextFromRegistry(registry, 'note', 'note-1', 'detail', {
      title: 'Hello',
      status: 'draft',
    });

    expect(ctx.entity).toBe('note');
    expect(ctx.id).toBe('note-1');
    expect(ctx.view).toBe('detail');
    expect(ctx.fields.title.current.value).toBe('Hello');
    expect(ctx.fields.title.meta.type).toBe('str');
    expect(ctx.fields.status.meta.type).toBe('lifecycle');
  });

  test('throws for missing binding', () => {
    seedHandlers();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const registry = compile([note, noteP]);

    expect(() =>
      createBindingContextFromRegistry(registry, 'note', 'note-1', 'detail', {}),
    ).toThrow("No binding for entity 'note' view 'detail'");
  });

  test('throws for unknown entity', () => {
    seedHandlers();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    // Create a binding so the first check passes, but look up wrong entity
    const noteB = bind(note, [
      { component: DetailComponent, view: 'detail', config: {} },
    ]);
    const registry = compile([note, noteP, noteB]);

    expect(() =>
      createBindingContextFromRegistry(registry, 'unknown', 'x', 'detail', {}),
    ).toThrow("No binding for entity 'unknown' view 'detail'");
  });
});
