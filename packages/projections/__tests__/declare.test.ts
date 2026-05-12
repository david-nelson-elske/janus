/**
 * Validation tests for declareProjection + select. Mirrors the
 * declare-side tests in @janus/channels: kebab name, fields, depth
 * cap, redaction shape.
 */

import { describe, expect, it } from 'bun:test';
import { declareProjection, select } from '../declare';

describe('declareProjection', () => {
  it('rejects non-kebab names', () => {
    expect(() =>
      declareProjection({
        name: 'BadName',
        selector: select({
          root: { entity: 'decision', byId: { from: 'params.id' } },
          fields: ['id'],
        }),
        description: 'x',
      }),
    ).toThrow(/kebab-case/);
  });

  it('requires a description', () => {
    expect(() =>
      declareProjection({
        name: 'no-desc',
        selector: select({
          root: { entity: 'decision', byId: { from: 'params.id' } },
          fields: ['id'],
        }),
        description: '',
      }),
    ).toThrow(/description is required/);
  });

  it('rejects empty fields list', () => {
    expect(() =>
      declareProjection({
        name: 'no-fields',
        selector: select({
          root: { entity: 'decision', byId: { from: 'params.id' } },
          fields: [],
        }),
        description: 'x',
      }),
    ).toThrow(/non-empty array/);
  });

  it('rejects root with both byId and list', () => {
    expect(() =>
      declareProjection({
        name: 'bad-root',
        selector: select({
          root: { entity: 'decision', byId: { from: 'p.id' }, list: true } as never,
          fields: ['id'],
        }),
        description: 'x',
      }),
    ).toThrow(/byId \/ where \/ list/);
  });

  it('caps selector depth', () => {
    const deep = {
      root: { entity: 'a' as const, byId: { from: 'params.id' } as const },
      fields: ['id'] as const,
      maxDepth: 2,
      relations: {
        bs: {
          kind: 'hasMany' as const,
          from: 'b',
          fields: ['id'] as const,
          relations: {
            cs: {
              kind: 'hasMany' as const,
              from: 'c',
              fields: ['id'] as const,
              relations: {
                ds: {
                  kind: 'hasMany' as const,
                  from: 'd',
                  fields: ['id'] as const,
                },
              },
            },
          },
        },
      },
    };
    expect(() =>
      declareProjection({
        name: 'deep',
        selector: deep as never,
        description: 'x',
      }),
    ).toThrow(/exceeds maxDepth/);
  });

  it('rejects unknown aggregate kind', () => {
    expect(() =>
      declareProjection({
        name: 'bad-agg',
        selector: select({
          root: { entity: 'decision', byId: { from: 'params.id' } },
          fields: ['id'],
          relations: {
            entries: {
              kind: 'hasMany',
              from: 'entry',
              fields: ['id'],
            },
          },
          aggregates: {
            // @ts-expect-error — intentionally bad kind
            broken: { kind: 'sum', relation: 'entries' },
          },
        }),
        description: 'x',
      }),
    ).toThrow(/invalid kind/);
  });

  it('accepts a well-formed declaration', () => {
    const decl = declareProjection({
      name: 'good',
      params: { id: 'string' } as const,
      selector: select({
        root: { entity: 'decision', byId: { from: 'params.id' } },
        fields: ['id', 'title'],
        relations: {
          sections: {
            kind: 'hasMany',
            from: 'section',
            where: { decision: { ref: 'root.id' } },
            fields: ['id', 'title'],
          },
        },
        aggregates: {
          sectionCount: { kind: 'count', relation: 'sections' },
        },
      }),
      redactions: {
        reviewer: ['title'],
      } as const,
      description: 'A well-formed test projection.',
    });
    expect(decl.name).toBe('good');
  });
});
