/**
 * Compose runtime tests with a stubbed EntityStore. Covers:
 *
 *   - byId / where / list roots
 *   - hasMany / belongsTo relations with parent + root references
 *   - count + exists aggregates
 *   - per-role redactions (dotted paths)
 *   - reference resolution: params.X / ctx.X / parent.X / root.X
 *   - missing-param validation
 */

import { describe, expect, it } from 'bun:test';
import type {
  EntityRecord,
  EntityStore,
  ReadPage,
  ReadParams,
} from '@janus/core';
import { compose } from '../compose';
import { declareProjection, select } from '../declare';
import { collectSelectorEntities } from '../publisher';

/**
 * Mint a record satisfying EntityRecord's required fields. Tests only
 * care about the domain fields; this fills in audit metadata.
 */
function rec(fields: Record<string, unknown>): EntityRecord {
  return {
    _version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'system',
    ...fields,
  } as EntityRecord;
}

interface StubTable {
  readonly entity: string;
  readonly records: readonly EntityRecord[];
}

function makeStore(tables: readonly StubTable[]): EntityStore {
  const byEntity = new Map<string, EntityRecord[]>();
  for (const t of tables) byEntity.set(t.entity, [...t.records]);

  function matches(record: EntityRecord, where: Record<string, unknown>): boolean {
    for (const [key, val] of Object.entries(where)) {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        if (record[key] !== val) return false;
        continue;
      }
      // operator object
      const op = val as Record<string, unknown>;
      if ('$in' in op) {
        const list = op.$in as readonly unknown[];
        if (!list.includes(record[key] as unknown)) return false;
        continue;
      }
      if ('$eq' in op) {
        if (record[key] !== op.$eq) return false;
        continue;
      }
      // unknown operator — fail closed
      return false;
    }
    return true;
  }

  const stub = {
    async read(entity: string, params?: ReadParams) {
      const all = byEntity.get(entity) ?? [];
      const p = params ?? {};
      if (typeof (p as { id?: unknown }).id === 'string') {
        const rec = all.find((r) => r.id === (p as { id: string }).id);
        return (rec ?? null) as EntityRecord | null;
      }
      const where = (p as { where?: Record<string, unknown> }).where ?? {};
      let records = all.filter((r) => matches(r, where));
      const sort = (p as { sort?: readonly { field: string; direction: 'asc' | 'desc' }[] }).sort;
      if (sort && sort.length > 0) {
        records = [...records].sort((a, b) => {
          for (const s of sort) {
            const av = a[s.field];
            const bv = b[s.field];
            if (av === bv) continue;
            const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
            return s.direction === 'asc' ? cmp : -cmp;
          }
          return 0;
        });
      }
      const limit = (p as { limit?: number }).limit;
      if (typeof limit === 'number') records = records.slice(0, limit);
      const page: ReadPage = { records, hasMore: false };
      return page;
    },
    async count(entity: string, where: Record<string, unknown>): Promise<number> {
      const all = byEntity.get(entity) ?? [];
      return all.filter((r) => matches(r, where)).length;
    },
    async create() { throw new Error('not used'); },
    async update() { throw new Error('not used'); },
    async delete() { throw new Error('not used'); },
    async withTransaction<T>(fn: (tx: EntityStore) => Promise<T>): Promise<T> {
      return fn(stub);
    },
    async initialize() {},
    async updateWhere(): Promise<number> { return 0; },
  } as unknown as EntityStore;
  return stub;
}

describe('compose — root resolution', () => {
  it('byId returns null when the record is absent', async () => {
    const store = makeStore([{ entity: 'decision', records: [] }]);
    const decl = declareProjection({
      name: 'd',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id', 'title'],
      }),
      description: 't',
    });
    expect(await compose(store, decl, { params: { id: 'missing' } })).toBeNull();
  });

  it('byId resolves the record and projects only declared fields', async () => {
    const store = makeStore([
      { entity: 'decision', records: [rec({ id: 'd1', title: 'T', secret: 'x' })] },
    ]);
    const decl = declareProjection({
      name: 'd',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id', 'title'],
      }),
      description: 't',
    });
    const view = await compose(store, decl, { params: { id: 'd1' } });
    expect(view).toEqual({ id: 'd1', title: 'T' });
  });

  it('list returns an array of projected records', async () => {
    const store = makeStore([
      {
        entity: 'journey',
        records: [
          rec({ id: 'j1', title: 'A', extra: 'x' }),
          rec({ id: 'j2', title: 'B', extra: 'y' }),
        ],
      },
    ]);
    const decl = declareProjection({
      name: 'j-list',
      selector: select({
        root: { entity: 'journey', list: true },
        fields: ['id', 'title'],
      }),
      description: 't',
    });
    const view = (await compose(store, decl, { params: {} })) as readonly Record<string, unknown>[];
    expect(view).toEqual([
      { id: 'j1', title: 'A' },
      { id: 'j2', title: 'B' },
    ]);
  });
});

describe('compose — relations + aggregates', () => {
  it('walks hasMany using parent references and aggregates counts', async () => {
    const store = makeStore([
      { entity: 'decision', records: [rec({ id: 'd1', title: 'T' })] },
      {
        entity: 'section',
        records: [
          rec({ id: 's1', decision: 'd1', title: 'A', order: 1 }),
          rec({ id: 's2', decision: 'd1', title: 'B', order: 2 }),
          rec({ id: 's-other', decision: 'd2', title: 'X', order: 1 }),
        ],
      },
      {
        entity: 'entry',
        records: [
          rec({ id: 'e1', section: 's1', content: 'a' }),
          rec({ id: 'e2', section: 's1', content: 'b' }),
        ],
      },
    ]);
    const decl = declareProjection({
      name: 'doc',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id', 'title'],
        relations: {
          sections: {
            kind: 'hasMany',
            from: 'section',
            where: { decision: { ref: 'root.id' } },
            sort: [{ field: 'order', direction: 'asc' }],
            fields: ['id', 'title', 'order'],
            relations: {
              entries: {
                kind: 'hasMany',
                from: 'entry',
                where: { section: { ref: 'parent.id' } },
                fields: ['id', 'content'],
              },
            },
            aggregates: {
              entryCount: { kind: 'count', relation: 'entries' },
            },
          },
        },
      }),
      description: 't',
    });
    const view = (await compose(store, decl, { params: { id: 'd1' } })) as Record<string, unknown>;
    expect(view).toEqual({
      id: 'd1',
      title: 'T',
      sections: [
        {
          id: 's1',
          title: 'A',
          order: 1,
          entries: [
            { id: 'e1', content: 'a' },
            { id: 'e2', content: 'b' },
          ],
          entryCount: 2,
        },
        {
          id: 's2',
          title: 'B',
          order: 2,
          entries: [],
          entryCount: 0,
        },
      ],
    });
  });
});

describe('compose — redactions', () => {
  it('removes redacted fields for the actor role', async () => {
    const store = makeStore([
      { entity: 'decision', records: [rec({ id: 'd1', title: 'T', secret: 'x' })] },
    ]);
    const decl = declareProjection({
      name: 'd',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id', 'title', 'secret'],
      }),
      redactions: { reviewer: ['secret'] } as const,
      description: 't',
    });
    const owner = await compose(store, decl, {
      params: { id: 'd1' },
      ctx: { actorRole: 'owner' },
    });
    expect(owner).toEqual({ id: 'd1', title: 'T', secret: 'x' });

    const reviewer = await compose(store, decl, {
      params: { id: 'd1' },
      ctx: { actorRole: 'reviewer' },
    });
    expect(reviewer).toEqual({ id: 'd1', title: 'T' });
  });
});

describe('compose — validation', () => {
  it('throws when a required param is missing', async () => {
    const store = makeStore([{ entity: 'decision', records: [] }]);
    const decl = declareProjection({
      name: 'd',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id'],
      }),
      description: 't',
    });
    expect(compose(store, decl, { params: {} })).rejects.toThrow(/missing required param/);
  });
});

describe('collectSelectorEntities', () => {
  it('returns the root entity plus every relation `from`', () => {
    const decl = declareProjection({
      name: 'd',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id'],
        relations: {
          sections: {
            kind: 'hasMany',
            from: 'section',
            fields: ['id'],
            relations: {
              entries: {
                kind: 'hasMany',
                from: 'entry',
                fields: ['id'],
              },
            },
          },
        },
      }),
      description: 't',
    });
    const entities = collectSelectorEntities(decl.selector);
    expect([...entities].sort()).toEqual(['decision', 'entry', 'section']);
  });
});
