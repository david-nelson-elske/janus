/**
 * Schema diff unit tests.
 */

import { describe, expect, test } from 'bun:test';
import { diffSchema } from '../schema-gen';
import { Str, Int, Markdown, Persistent } from '@janus/vocabulary';

describe('diffSchema', () => {
  test('identifies new columns as additions', () => {
    const meta = {
      entity: 'note',
      table: 'note',
      schema: {
        title: Str({ required: true }),
        body: Markdown(),
        count: Int(),
      },
      storage: Persistent(),
    };

    const existingColumns = [
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
    ];

    const diff = diffSchema(meta, existingColumns);

    expect(diff.hasChanges).toBe(true);
    expect(diff.additions).toHaveLength(2);
    expect(diff.additions.map(a => a.name)).toContain('body');
    expect(diff.additions.map(a => a.name)).toContain('count');
    expect(diff.removals).toHaveLength(0);
  });

  test('generates correct ALTER TABLE SQL', () => {
    const meta = {
      entity: 'note',
      table: 'note',
      schema: { title: Str(), body: Markdown(), count: Int() },
      storage: Persistent(),
    };

    const existingColumns = [
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
    ];

    const diff = diffSchema(meta, existingColumns);

    const bodyAdd = diff.additions.find(a => a.name === 'body');
    expect(bodyAdd?.sql).toBe('ALTER TABLE "note" ADD COLUMN "body" TEXT');

    const countAdd = diff.additions.find(a => a.name === 'count');
    expect(countAdd?.sql).toBe('ALTER TABLE "note" ADD COLUMN "count" INTEGER');
  });

  test('identifies removed columns as warnings', () => {
    const meta = {
      entity: 'note',
      table: 'note',
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    };

    const existingColumns = [
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'old_field', type: 'TEXT', notnull: 0, pk: 0 },
    ];

    const diff = diffSchema(meta, existingColumns);

    expect(diff.hasChanges).toBe(true);
    expect(diff.additions).toHaveLength(0);
    expect(diff.removals).toEqual(['old_field']);
  });

  test('no changes when schema matches table', () => {
    const meta = {
      entity: 'note',
      table: 'note',
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    };

    const existingColumns = [
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
    ];

    const diff = diffSchema(meta, existingColumns);
    expect(diff.hasChanges).toBe(false);
  });

  test('ignores framework columns in removal detection', () => {
    const meta = {
      entity: 'note',
      table: 'note',
      schema: { title: Str() },
      storage: Persistent(),
    };

    // Framework columns (id, _version, etc.) should not appear as removals
    const existingColumns = [
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
      { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
    ];

    const diff = diffSchema(meta, existingColumns);
    expect(diff.removals).toHaveLength(0);
  });
});
