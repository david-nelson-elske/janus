import { describe, expect, test } from 'bun:test';
import {
  Str, Int, Float, Bool, Json, Markdown, Email, Url, Enum, Slug, Phone, Cron,
  Persistent, Lifecycle, Reference, Relation, Mention,
} from '@janus/vocabulary';
import {
  sqliteType, postgresType,
  generateCreateTable, generateCreateTablePg,
  getSearchableFields, generateFtsTable, generateFtsTriggers,
  generatePgFtsSetup, generateIndexes, diffSchema,
} from '..';
import type { AdapterMeta, ColumnInfo } from '..';

// ── Helpers ──────────────────────────────────────────────────────

function makeMeta(schema: AdapterMeta['schema'], overrides?: Partial<AdapterMeta>): AdapterMeta {
  return {
    entity: overrides?.entity ?? 'test_entity',
    table: overrides?.table ?? overrides?.entity ?? 'test_entity',
    schema,
    storage: Persistent(),
    indexes: overrides?.indexes,
  };
}

// ── Type mapping ─────────────────────────────────────────────────

describe('sqliteType', () => {
  test('str → TEXT', () => expect(sqliteType(Str())).toBe('TEXT'));
  test('int → INTEGER', () => expect(sqliteType(Int())).toBe('INTEGER'));
  test('float → REAL', () => expect(sqliteType(Float())).toBe('REAL'));
  test('bool → INTEGER', () => expect(sqliteType(Bool())).toBe('INTEGER'));
  test('json → TEXT', () => expect(sqliteType(Json())).toBe('TEXT'));
  test('markdown → TEXT', () => expect(sqliteType(Markdown())).toBe('TEXT'));
  test('email → TEXT', () => expect(sqliteType(Email())).toBe('TEXT'));
  test('enum → TEXT', () => expect(sqliteType(Enum(['a', 'b']))).toBe('TEXT'));

  test('unknown kind falls back to TEXT', () => {
    const fake = { kind: 'unknown_kind_xyz' } as any;
    expect(sqliteType(fake)).toBe('TEXT');
  });
});

describe('postgresType', () => {
  test('str → TEXT', () => expect(postgresType(Str())).toBe('TEXT'));
  test('int → INTEGER', () => expect(postgresType(Int())).toBe('INTEGER'));
  test('float → DOUBLE PRECISION', () => expect(postgresType(Float())).toBe('DOUBLE PRECISION'));
  test('bool → BOOLEAN', () => expect(postgresType(Bool())).toBe('BOOLEAN'));
  test('datetime → TIMESTAMPTZ', () => {
    const { DateTime } = require('@janus/vocabulary');
    expect(postgresType(DateTime())).toBe('TIMESTAMPTZ');
  });
  test('json → JSONB', () => expect(postgresType(Json())).toBe('JSONB'));

  test('unknown kind falls back to TEXT', () => {
    const fake = { kind: 'unknown_kind_xyz' } as any;
    expect(postgresType(fake)).toBe('TEXT');
  });
});

// ── DDL generation ───────────────────────────────────────────────

describe('generateCreateTable', () => {
  test('produces CREATE TABLE with framework columns', () => {
    const meta = makeMeta({ title: Str() });
    const ddl = generateCreateTable(meta);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
    expect(ddl).toContain('id TEXT PRIMARY KEY');
    expect(ddl).toContain('_version INTEGER NOT NULL');
    expect(ddl).toContain('createdAt TEXT NOT NULL');
    expect(ddl).toContain('createdBy TEXT NOT NULL');
    expect(ddl).toContain('updatedAt TEXT NOT NULL');
    expect(ddl).toContain('updatedBy TEXT NOT NULL');
    expect(ddl).toContain('_deletedAt TEXT');
  });

  test('includes schema fields with correct types', () => {
    const meta = makeMeta({ title: Str(), count: Int(), data: Json() });
    const ddl = generateCreateTable(meta);
    expect(ddl).toContain('"title" TEXT');
    expect(ddl).toContain('"count" INTEGER');
    expect(ddl).toContain('"data" TEXT');
  });

  test('required fields get NOT NULL', () => {
    const meta = makeMeta({ name: Str({ required: true }), desc: Str() });
    const ddl = generateCreateTable(meta);
    expect(ddl).toContain('"name" TEXT NOT NULL');
    // desc should NOT have NOT NULL
    expect(ddl).toMatch(/"desc" TEXT(?! NOT NULL)/);
  });

  test('lifecycle fields get TEXT type', () => {
    const meta = makeMeta({ status: Lifecycle({ draft: ['published'], published: [] }) });
    const ddl = generateCreateTable(meta);
    expect(ddl).toContain('"status" TEXT');
  });

  test('wiring types get TEXT type', () => {
    const meta = makeMeta({
      owner: Reference('user'),
      parent: Relation('folder', {}),
    });
    const ddl = generateCreateTable(meta);
    expect(ddl).toContain('"owner" TEXT');
    expect(ddl).toContain('"parent" TEXT');
  });
});

// ── FTS ──────────────────────────────────────────────────────────

describe('getSearchableFields', () => {
  test('returns str, markdown, email fields', () => {
    const meta = makeMeta({
      title: Str(),
      body: Markdown(),
      contact: Email(),
      count: Int(),
    });
    const fields = getSearchableFields(meta);
    expect(fields).toContain('title');
    expect(fields).toContain('body');
    expect(fields).toContain('contact');
    expect(fields).not.toContain('count');
  });

  test('respects searchable: false hint', () => {
    const meta = makeMeta({
      title: Str(),
      secret: Str({ searchable: false }),
    });
    const fields = getSearchableFields(meta);
    expect(fields).toContain('title');
    expect(fields).not.toContain('secret');
  });

  test('returns empty array when no searchable fields', () => {
    const meta = makeMeta({ count: Int(), flag: Bool() });
    expect(getSearchableFields(meta)).toEqual([]);
  });
});

describe('generateFtsTable', () => {
  test('returns FTS5 virtual table DDL', () => {
    const meta = makeMeta({ title: Str(), body: Markdown() });
    const fts = generateFtsTable(meta);
    expect(fts).not.toBeNull();
    expect(fts).toContain('CREATE VIRTUAL TABLE');
    expect(fts).toContain('USING fts5');
    expect(fts).toContain('title');
    expect(fts).toContain('body');
  });

  test('returns null when no searchable fields', () => {
    const meta = makeMeta({ count: Int() });
    expect(generateFtsTable(meta)).toBeNull();
  });
});

describe('generateFtsTriggers', () => {
  test('returns 3 triggers (ai, ad, au)', () => {
    const meta = makeMeta({ title: Str() });
    const triggers = generateFtsTriggers(meta);
    expect(triggers).not.toBeNull();
    expect(triggers).toHaveLength(3);
    expect(triggers![0]).toContain('AFTER INSERT');
    expect(triggers![1]).toContain('AFTER DELETE');
    expect(triggers![2]).toContain('AFTER UPDATE');
  });

  test('returns null when no searchable fields', () => {
    const meta = makeMeta({ count: Int() });
    expect(generateFtsTriggers(meta)).toBeNull();
  });
});

// ── Postgres DDL ─────────────────────────────────────────────────

describe('generateCreateTablePg', () => {
  test('produces Postgres DDL with TIMESTAMPTZ', () => {
    const meta = makeMeta({ title: Str() });
    const ddl = generateCreateTablePg(meta);
    expect(ddl).toContain('createdAt TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('updatedAt TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('_deletedAt TIMESTAMPTZ');
  });

  test('adds _tsv column when searchable fields exist', () => {
    const meta = makeMeta({ title: Str(), body: Markdown() });
    const ddl = generateCreateTablePg(meta);
    expect(ddl).toContain('_tsv tsvector');
  });

  test('no _tsv column when no searchable fields', () => {
    const meta = makeMeta({ count: Int() });
    const ddl = generateCreateTablePg(meta);
    expect(ddl).not.toContain('_tsv');
  });

  test('JSONB type for json fields', () => {
    const meta = makeMeta({ data: Json() });
    const ddl = generateCreateTablePg(meta);
    expect(ddl).toContain('"data" JSONB');
  });
});

describe('generatePgFtsSetup', () => {
  test('returns GIN index, trigger function, and trigger', () => {
    const meta = makeMeta({ title: Str(), body: Markdown() });
    const setup = generatePgFtsSetup(meta);
    expect(setup).not.toBeNull();
    expect(setup!.index).toContain('USING gin');
    expect(setup!.triggerFn).toContain('to_tsvector');
    expect(setup!.trigger).toContain('BEFORE INSERT OR UPDATE');
  });

  test('returns null when no searchable fields', () => {
    const meta = makeMeta({ count: Int() });
    expect(generatePgFtsSetup(meta)).toBeNull();
  });
});

// ── Indexes ──────────────────────────────────────────────────────

describe('generateIndexes', () => {
  test('returns CREATE INDEX statements', () => {
    const meta = makeMeta({ title: Str(), status: Str() }, {
      indexes: [{ fields: ['title'] }],
    });
    const stmts = generateIndexes(meta);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('CREATE INDEX');
    expect(stmts[0]).toContain('"title"');
  });

  test('unique indexes include UNIQUE keyword', () => {
    const meta = makeMeta({ slug: Slug() }, {
      indexes: [{ fields: ['slug'], unique: true }],
    });
    const stmts = generateIndexes(meta);
    expect(stmts[0]).toContain('UNIQUE INDEX');
  });

  test('custom index names used when provided', () => {
    const meta = makeMeta({ title: Str() }, {
      indexes: [{ fields: ['title'], name: 'my_custom_idx' }],
    });
    const stmts = generateIndexes(meta);
    expect(stmts[0]).toContain('my_custom_idx');
  });

  test('auto-generated names when no name provided', () => {
    const meta = makeMeta({ title: Str() }, {
      entity: 'note',
      indexes: [{ fields: ['title'] }],
    });
    const stmts = generateIndexes(meta);
    expect(stmts[0]).toContain('idx_note_title');
  });

  test('empty array for no indexes', () => {
    const meta = makeMeta({ title: Str() });
    expect(generateIndexes(meta)).toEqual([]);
  });

  test('empty array when indexes is empty', () => {
    const meta = makeMeta({ title: Str() }, { indexes: [] });
    expect(generateIndexes(meta)).toEqual([]);
  });
});

// ── Schema diff ──────────────────────────────────────────────────

describe('diffSchema', () => {
  const existing: ColumnInfo[] = [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: '_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'createdAt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'createdBy', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updatedAt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updatedBy', type: 'TEXT', notnull: 1, pk: 0 },
    { name: '_deletedAt', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
  ];

  test('detects new columns (additions)', () => {
    const meta = makeMeta({ title: Str(), summary: Str() });
    const diff = diffSchema(meta, existing);
    expect(diff.additions).toHaveLength(1);
    expect(diff.additions[0].name).toBe('summary');
    expect(diff.additions[0].sql).toContain('ALTER TABLE');
    expect(diff.additions[0].sql).toContain('"summary"');
    expect(diff.hasChanges).toBe(true);
  });

  test('detects removed columns (removals) excluding framework columns', () => {
    // Schema has no title, but existing DB does
    const meta = makeMeta({ name: Str() });
    const diff = diffSchema(meta, existing);
    expect(diff.removals).toContain('title');
    expect(diff.hasChanges).toBe(true);
  });

  test('reports hasChanges=false when schema matches', () => {
    const meta = makeMeta({ title: Str() });
    const diff = diffSchema(meta, existing);
    expect(diff.hasChanges).toBe(false);
    expect(diff.additions).toHaveLength(0);
    expect(diff.removals).toHaveLength(0);
  });

  test('framework columns are never reported as removals', () => {
    // Schema has no fields at all — but framework columns should NOT appear as removals
    const meta = makeMeta({});
    const diff = diffSchema(meta, existing);
    // title is in DB but not in schema → removal
    expect(diff.removals).toContain('title');
    // framework columns should NOT be in removals
    expect(diff.removals).not.toContain('id');
    expect(diff.removals).not.toContain('_version');
    expect(diff.removals).not.toContain('createdAt');
    expect(diff.removals).not.toContain('createdBy');
    expect(diff.removals).not.toContain('updatedAt');
    expect(diff.removals).not.toContain('updatedBy');
    expect(diff.removals).not.toContain('_deletedAt');
  });

  test('new lifecycle field produces ALTER TABLE ADD COLUMN TEXT', () => {
    const meta = makeMeta({
      title: Str(),
      status: Lifecycle({ draft: ['published'], published: [] }),
    });
    const diff = diffSchema(meta, existing);
    expect(diff.additions).toHaveLength(1);
    expect(diff.additions[0].name).toBe('status');
    expect(diff.additions[0].sql).toContain('TEXT');
  });

  test('new wiring field produces ALTER TABLE ADD COLUMN TEXT', () => {
    const meta = makeMeta({
      title: Str(),
      owner: Reference('user'),
    });
    const diff = diffSchema(meta, existing);
    expect(diff.additions).toHaveLength(1);
    expect(diff.additions[0].name).toBe('owner');
    expect(diff.additions[0].sql).toContain('TEXT');
  });
});
