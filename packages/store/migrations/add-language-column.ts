/**
 * addLanguageColumn — idempotent migration helper for adding a new
 * language to an entity that already has translatable fields.
 *
 * For each translatable field on `entity`, generates the matching
 * `<field>_<lang>` column if it doesn't exist. Returns the list of columns
 * actually added (empty when there's nothing to do — i.e. on re-run).
 *
 * The helper is designed to be called from app-level migration scripts
 * (or directly from app boot when adopting a new language). It does not
 * touch translatable values — the new columns are NULL until a translator
 * fills them in. The framework's read-time fallback ensures the page still
 * renders in the default language while translation work is pending.
 *
 * Use cases:
 * - Adding French to an existing English-only deployment (`addLanguageColumn(store, 'news', 'fr')`).
 * - Per-tenant or per-region language enablement.
 * - Backfill workflows in tooling.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { isTranslatableField, isSemanticField, translatableColumnName } from '@janus/vocabulary';
import type { SchemaField } from '@janus/core';
import { sqliteType, postgresType, tableName } from '../schema-gen';

export interface AddLanguageColumnConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
  readonly db: Kysely<any>;
  /** Entity (table) name. */
  readonly entity: string;
  /** Schema describing translatable fields on the entity. */
  readonly schema: Readonly<Record<string, SchemaField>>;
  /** Language code to provision (e.g. 'fr'). Must NOT be the default lang. */
  readonly lang: string;
  /** Default language — used for column-name derivation. */
  readonly defaultLang: string;
  /** Database dialect — drives type mapping. Default: 'sqlite'. */
  readonly dialect?: 'sqlite' | 'postgres';
}

export interface AddLanguageColumnResult {
  readonly added: readonly string[];
  readonly skipped: readonly string[];
}

export async function addLanguageColumn(
  config: AddLanguageColumnConfig,
): Promise<AddLanguageColumnResult> {
  const { db, entity, schema, lang, defaultLang } = config;
  if (lang === defaultLang) {
    throw new Error(
      `addLanguageColumn: lang "${lang}" is the default language — its column already exists as the bare field name`,
    );
  }
  const dialect = config.dialect ?? 'sqlite';
  const tbl = tableName(entity);

  const existing = await readExistingColumns(db, tbl, dialect);
  const added: string[] = [];
  const skipped: string[] = [];

  for (const [name, def] of Object.entries(schema)) {
    if (!isTranslatableField(def)) continue;
    const colName = translatableColumnName(name, lang, defaultLang);
    if (existing.has(colName)) {
      skipped.push(colName);
      continue;
    }
    const inner = def.base;
    const baseType = isSemanticField(inner)
      ? dialect === 'postgres'
        ? postgresType(inner)
        : sqliteType(inner)
      : 'TEXT';
    await sql
      .raw(`ALTER TABLE "${tbl}" ADD COLUMN "${colName}" ${baseType}`)
      .execute(db);
    added.push(colName);
  }

  return { added, skipped };
}

async function readExistingColumns(
  // biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
  db: Kysely<any>,
  tbl: string,
  dialect: 'sqlite' | 'postgres',
): Promise<Set<string>> {
  if (dialect === 'sqlite') {
    const rows = (await sql
      .raw(`PRAGMA table_info("${tbl}")`)
      .execute(db)) as { rows: Record<string, unknown>[] };
    return new Set((rows.rows as { name: string }[]).map((r) => r.name));
  }
  const rows = (await sql
    .raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tbl.replace(/'/g, "''")}'`,
    )
    .execute(db)) as { rows: Record<string, unknown>[] };
  return new Set((rows.rows as { column_name: string }[]).map((r) => r.column_name));
}
