/**
 * Wave 3 — Translatable<T> field tests across adapters.
 *
 * Validates the parallel-column model: schema generates per-language columns,
 * writes route bare values to `<field>_<lang>` when lang ≠ default, reads
 * resolve `record.<field>` against the active language, and the migration
 * helper safely adds a new language column to an existing table.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Persistent, Singleton, Str, Translatable } from '@janus/vocabulary';
import {
  addLanguageColumn,
  createMemoryAdapter,
  createSqliteAdapter,
  diffSchema,
  generateCreateTable,
  resolveTranslatableConfig,
  rewriteReadRecord,
  rewriteWhereClause,
  rewriteWriteRecord,
} from '..';
import type { AdapterMeta } from '../store-adapter';

const newsSchema = {
  title: Translatable(Str({ required: true })),
  body: Translatable(Str()),
  category: Str(),
};

const newsMeta: AdapterMeta = {
  entity: 'news',
  table: 'news',
  schema: newsSchema,
  storage: Persistent(),
};

const enFr = resolveTranslatableConfig({ langs: ['en', 'fr'], defaultLang: 'en' });

// ── Helpers ────────────────────────────────────────────────────────

describe('translatable helpers (pure)', () => {
  test('rewriteWriteRecord routes bare values to lang column when lang ≠ default', () => {
    const out = rewriteWriteRecord(
      { title: 'Bonjour', body: 'Salut', category: 'analysis' },
      newsSchema,
      enFr,
      'fr',
    );
    expect(out).toEqual({ title_fr: 'Bonjour', body_fr: 'Salut', category: 'analysis' });
  });

  test('rewriteWriteRecord is a no-op for default-lang writes', () => {
    const input = { title: 'Hello', category: 'analysis' };
    expect(rewriteWriteRecord(input, newsSchema, enFr, 'en')).toEqual(input);
  });

  test('rewriteReadRecord resolves to active lang with fallback', () => {
    // FR present
    expect(
      rewriteReadRecord(
        { title: 'Hello', title_fr: 'Bonjour', category: 'analysis' },
        newsSchema,
        enFr,
        'fr',
      ),
    ).toMatchObject({ title: 'Bonjour' });

    // FR null → falls back to EN by default
    expect(
      rewriteReadRecord(
        { title: 'Hello', title_fr: null, category: 'analysis' },
        newsSchema,
        enFr,
        'fr',
      ),
    ).toMatchObject({ title: 'Hello' });
  });

  test('rewriteReadRecord with fallbackOnMissing=false surfaces null', () => {
    const strict = resolveTranslatableConfig({
      langs: ['en', 'fr'],
      defaultLang: 'en',
      fallbackOnMissing: false,
    });
    const out = rewriteReadRecord(
      { title: 'Hello', title_fr: null },
      newsSchema,
      strict,
      'fr',
    );
    expect(out.title).toBeNull();
  });

  test('rewriteWhereClause rewrites translatable field references', () => {
    expect(
      rewriteWhereClause({ title: { $like: '%Bonjour%' }, category: 'analysis' }, newsSchema, enFr, 'fr'),
    ).toEqual({ title_fr: { $like: '%Bonjour%' }, category: 'analysis' });
  });
});

// ── Schema generation ──────────────────────────────────────────────

describe('SQLite schema generation', () => {
  test('CREATE TABLE provisions per-language columns', () => {
    const ddl = generateCreateTable(newsMeta, enFr);
    expect(ddl).toContain('"title" TEXT NOT NULL');
    expect(ddl).toContain('"title_fr" TEXT');
    expect(ddl).toContain('"body" TEXT');
    expect(ddl).toContain('"body_fr" TEXT');
    expect(ddl).toContain('"category" TEXT');
    // Translation columns are nullable even if base is required.
    expect(ddl).not.toContain('"title_fr" TEXT NOT NULL');
  });

  test('diffSchema reports missing language columns as additions', () => {
    const diff = diffSchema(
      newsMeta,
      [
        { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'body', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'category', type: 'TEXT', notnull: 0, pk: 0 },
      ],
      enFr,
    );
    const names = diff.additions.map((a) => a.name);
    expect(names).toContain('title_fr');
    expect(names).toContain('body_fr');
    expect(diff.removals).toEqual([]);
  });
});

// ── Memory adapter end-to-end ──────────────────────────────────────

describe('memory adapter — translatable read/write', () => {
  test('write in fr stores under _fr column; default read returns en; fr read flips', async () => {
    const adapter = createMemoryAdapter({ translatable: { langs: ['en', 'fr'] } });
    await adapter.initialize(newsMeta);
    const created = await adapter.create(newsMeta, {
      id: 'n1',
      title: 'Hello',
      body: 'World',
      category: 'analysis',
    });
    // The default-lang write goes to bare columns.
    expect(created.title).toBe('Hello');

    // Targeted FR write via __lang sentinel.
    const updated = await adapter.update(
      newsMeta,
      'n1',
      { title: 'Bonjour' },
      { lang: 'fr' },
    );
    // Update returns the full record post-merge — title_fr should now be set
    // and the bare title is unchanged.
    expect((updated as Record<string, unknown>).title_fr).toBe('Bonjour');
    expect((updated as Record<string, unknown>).title).toBe('Hello');

    // Default read (no lang): bare values.
    const enRead = await adapter.read(newsMeta, { id: 'n1' });
    expect((enRead as Record<string, unknown>).title).toBe('Hello');

    // FR read: resolved to French.
    const frRead = await adapter.read(newsMeta, { id: 'n1', lang: 'fr' });
    expect((frRead as Record<string, unknown>).title).toBe('Bonjour');
  });

  test('FR read falls back to default lang when _fr is absent', async () => {
    const adapter = createMemoryAdapter({ translatable: { langs: ['en', 'fr'] } });
    await adapter.initialize(newsMeta);
    await adapter.create(newsMeta, { id: 'n2', title: 'Untranslated', category: 'policy' });
    const frRead = await adapter.read(newsMeta, { id: 'n2', lang: 'fr' });
    expect((frRead as Record<string, unknown>).title).toBe('Untranslated');
  });

  test('list filter on translatable field hits active-lang column', async () => {
    const adapter = createMemoryAdapter({ translatable: { langs: ['en', 'fr'] } });
    await adapter.initialize(newsMeta);
    await adapter.create(newsMeta, { id: 'a', title: 'Apple', category: 'analysis' });
    await adapter.update(newsMeta, 'a', { title: 'Pomme' }, { lang: 'fr' });
    await adapter.create(newsMeta, { id: 'b', title: 'Banana', category: 'analysis' });

    const frPage = await adapter.read(newsMeta, {
      where: { title: 'Pomme' },
      lang: 'fr',
    });
    expect('records' in frPage).toBe(true);
    if ('records' in frPage) {
      expect(frPage.records.map((r) => r.id)).toEqual(['a']);
    }
  });
});

// ── SQLite adapter end-to-end ──────────────────────────────────────

describe('sqlite adapter — translatable schema + read/write', () => {
  const dbPath = join(tmpdir(), `janus-translatable-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch { /* ignore */ }
    try {
      unlinkSync(`${dbPath}-wal`);
    } catch { /* ignore */ }
    try {
      unlinkSync(`${dbPath}-shm`);
    } catch { /* ignore */ }
  });

  test('initialize provisions parallel columns and reads/writes resolve per-lang', async () => {
    const adapter = createSqliteAdapter({
      path: dbPath,
      translatable: { langs: ['en', 'fr'] },
    });
    await adapter.initialize(newsMeta);
    await adapter.finalize();

    await adapter.create(newsMeta, {
      id: 'art1',
      title: 'Hello',
      body: 'World',
      category: 'analysis',
    });
    await adapter.update(newsMeta, 'art1', { title: 'Bonjour' }, { lang: 'fr' });

    // Default-lang read returns English.
    const enRead = await adapter.read(newsMeta, { id: 'art1' });
    expect((enRead as Record<string, unknown>).title).toBe('Hello');

    // FR read resolves to French.
    const frRead = await adapter.read(newsMeta, { id: 'art1', lang: 'fr' });
    expect((frRead as Record<string, unknown>).title).toBe('Bonjour');
  });

  test('addLanguageColumn provisions a new lang column on an existing table', async () => {
    // Boot with EN only — DB has bare `title` column.
    const adapter1 = createSqliteAdapter({
      path: dbPath,
      translatable: { langs: ['en'] },
    });
    await adapter1.initialize(newsMeta);
    await adapter1.finalize();
    await adapter1.create(newsMeta, { id: 'm1', title: 'Hello', category: 'policy' });

    // Adopt FR via the migration helper.
    // biome-ignore lint/suspicious/noExplicitAny: probe internal db
    const dbHandle = (adapter1 as any).db;
    const result = await addLanguageColumn({
      db: dbHandle,
      entity: 'news',
      schema: newsSchema,
      lang: 'fr',
      defaultLang: 'en',
      dialect: 'sqlite',
    });
    expect(result.added).toContain('title_fr');
    expect(result.added).toContain('body_fr');

    // Re-running is a no-op.
    const second = await addLanguageColumn({
      db: dbHandle,
      entity: 'news',
      schema: newsSchema,
      lang: 'fr',
      defaultLang: 'en',
      dialect: 'sqlite',
    });
    expect(second.added).toEqual([]);
  });

  test('rejects adding the default language', async () => {
    const adapter = createSqliteAdapter({
      path: dbPath,
      translatable: { langs: ['en'] },
    });
    await adapter.initialize(newsMeta);
    await adapter.finalize();
    // biome-ignore lint/suspicious/noExplicitAny: probe internal db
    const dbHandle = (adapter as any).db;
    await expect(
      addLanguageColumn({
        db: dbHandle,
        entity: 'news',
        schema: newsSchema,
        lang: 'en',
        defaultLang: 'en',
        dialect: 'sqlite',
      }),
    ).rejects.toThrow(/default language/);
  });
});

// ── Singleton storage hook (smoke) ─────────────────────────────────

describe('schema storage strategies still typecheck', () => {
  test('Singleton + Translatable compiles', () => {
    const _meta: AdapterMeta = {
      entity: 'home',
      table: 'home',
      schema: { hero: Translatable(Str()) },
      storage: Singleton({ defaults: {} }),
    };
    expect(_meta.entity).toBe('home');
  });
});
