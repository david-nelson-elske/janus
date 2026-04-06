/**
 * Tests for Postgres-specific schema generation — DDL, FTS, type mapping.
 * No database required.
 */

import { describe, test, expect } from 'bun:test';
import { Str, Int, Float, Bool, DateTime, Enum, Json, Markdown, Email, Persistent } from '@janus/vocabulary';
import type { AdapterMeta } from '@janus/store';
import {
  postgresType,
  generateCreateTablePg,
  generatePgFtsSetup,
  getSearchableFields,
} from '@janus/store';

function meta(entity: string, schema: Record<string, unknown>, overrides?: Partial<AdapterMeta>): AdapterMeta {
  return {
    entity,
    table: entity,
    schema: schema as AdapterMeta['schema'],
    storage: Persistent(),
    ...overrides,
  };
}

describe('postgresType', () => {
  test('maps semantic types to Postgres SQL types', () => {
    expect(postgresType(Str())).toBe('TEXT');
    expect(postgresType(Int())).toBe('INTEGER');
    expect(postgresType(Float())).toBe('DOUBLE PRECISION');
    expect(postgresType(Bool())).toBe('BOOLEAN');
    expect(postgresType(DateTime())).toBe('TIMESTAMPTZ');
    expect(postgresType(Json())).toBe('JSONB');
    expect(postgresType(Markdown())).toBe('TEXT');
    expect(postgresType(Email())).toBe('TEXT');
  });

  test('differs from SQLite types for bool, datetime, json, float', () => {
    // These are the key differences between SQLite and Postgres
    expect(postgresType(Bool())).not.toBe('INTEGER');   // SQLite uses INTEGER
    expect(postgresType(DateTime())).not.toBe('TEXT');   // SQLite uses TEXT
    expect(postgresType(Json())).not.toBe('TEXT');       // SQLite uses TEXT
    expect(postgresType(Float())).not.toBe('REAL');      // SQLite uses REAL
  });
});

describe('generateCreateTablePg', () => {
  test('generates CREATE TABLE with Postgres types', () => {
    const m = meta('event', {
      title: Str({ required: true }),
      active: Bool(),
      start_at: DateTime(),
      metadata: Json(),
      capacity: Int(),
    });
    const ddl = generateCreateTablePg(m);

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "event"');
    expect(ddl).toContain('id TEXT PRIMARY KEY');
    expect(ddl).toContain('_version INTEGER NOT NULL DEFAULT 1');
    expect(ddl).toContain('createdAt TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('updatedAt TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('_deletedAt TIMESTAMPTZ');
    expect(ddl).toContain('"title" TEXT NOT NULL');
    expect(ddl).toContain('"active" BOOLEAN');
    expect(ddl).toContain('"start_at" TIMESTAMPTZ');
    expect(ddl).toContain('"metadata" JSONB');
    expect(ddl).toContain('"capacity" INTEGER');
  });

  test('adds _tsv tsvector column when entity has searchable fields', () => {
    const m = meta('article', {
      title: Str({ required: true }),
      body: Markdown(),
      count: Int(),
    });
    const ddl = generateCreateTablePg(m);

    // title (Str) and body (Markdown) are searchable, so _tsv should be present
    expect(ddl).toContain('_tsv tsvector');
  });

  test('omits _tsv when no searchable fields', () => {
    const m = meta('counter', {
      value: Int({ required: true }),
      active: Bool(),
    });
    const ddl = generateCreateTablePg(m);

    expect(ddl).not.toContain('_tsv');
  });
});

describe('generatePgFtsSetup', () => {
  test('generates GIN index, trigger function, and trigger', () => {
    const m = meta('article', {
      title: Str({ required: true }),
      body: Markdown(),
      email: Email(),
    });
    const fts = generatePgFtsSetup(m);

    expect(fts).not.toBeNull();
    expect(fts!.index).toContain('CREATE INDEX IF NOT EXISTS "article_tsv_idx"');
    expect(fts!.index).toContain('USING gin(_tsv)');

    expect(fts!.triggerFn).toContain('CREATE OR REPLACE FUNCTION "article_tsv_update"()');
    expect(fts!.triggerFn).toContain("to_tsvector('english'");
    expect(fts!.triggerFn).toContain('coalesce(NEW."title"');
    expect(fts!.triggerFn).toContain('coalesce(NEW."body"');
    expect(fts!.triggerFn).toContain('coalesce(NEW."email"');
    expect(fts!.triggerFn).toContain('LANGUAGE plpgsql');

    expect(fts!.trigger).toContain('CREATE OR REPLACE TRIGGER "article_tsv_trigger"');
    expect(fts!.trigger).toContain('BEFORE INSERT OR UPDATE');
    expect(fts!.trigger).toContain('EXECUTE FUNCTION "article_tsv_update"()');
  });

  test('returns null when no searchable fields', () => {
    const m = meta('config', {
      value: Int(),
      active: Bool(),
    });
    expect(generatePgFtsSetup(m)).toBeNull();
  });

  test('respects searchable: false hint', () => {
    const m = meta('secret', {
      name: Str({ required: true }),
      internal_code: Str({ searchable: false }),
    });
    const fields = getSearchableFields(m);
    expect(fields).toEqual(['name']);
    expect(fields).not.toContain('internal_code');
  });
});

describe('generateSnapshot with postgresType', () => {
  test('snapshot records Postgres-specific SQL types', async () => {
    const { generateSnapshot, postgresType: pgType } = await import('@janus/store');
    const m = meta('event', {
      title: Str({ required: true }),
      active: Bool(),
      start_at: DateTime(),
      metadata: Json(),
    });
    const snapshot = generateSnapshot(m, pgType);

    const fieldMap = new Map(snapshot.fields.map((f) => [f.name, f]));
    expect(fieldMap.get('title')!.sqlType).toBe('TEXT');
    expect(fieldMap.get('active')!.sqlType).toBe('BOOLEAN');
    expect(fieldMap.get('start_at')!.sqlType).toBe('TIMESTAMPTZ');
    expect(fieldMap.get('metadata')!.sqlType).toBe('JSONB');
  });
});
