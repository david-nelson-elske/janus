/**
 * Adapter helpers for `Translatable<T>` fields.
 *
 * Adapters store one column per (field, lang) pair: the default-lang value
 * lives in the bare field name (`title`), other langs in `<field>_<lang>`
 * (`title_fr`). These helpers rewrite between the application's view of a
 * record (bare field names, active language resolved) and the storage view
 * (parallel columns).
 *
 * Adapters are configured with `langs[]` + `defaultLang`. When unset, the
 * helpers are no-ops and the adapter behaves like a non-i18n adapter.
 */

import type { SchemaField } from '@janus/core';
import { isTranslatableField, translatableColumnName } from '@janus/vocabulary';

export interface TranslatableConfig {
  /** Configured language codes. First is the default unless `defaultLang` set. */
  readonly langs?: readonly string[];
  /** Default language. Must be in `langs`. Defaults to `langs[0]`. */
  readonly defaultLang?: string;
  /** When a record's active-lang column is null/undefined, fall back to default. Default true. */
  readonly fallbackOnMissing?: boolean;
}

export interface ResolvedTranslatableConfig {
  readonly langs: readonly string[];
  readonly defaultLang: string;
  readonly fallbackOnMissing: boolean;
}

export function resolveTranslatableConfig(
  config?: TranslatableConfig,
): ResolvedTranslatableConfig | null {
  if (!config?.langs || config.langs.length === 0) return null;
  const defaultLang = config.defaultLang ?? config.langs[0];
  if (!config.langs.includes(defaultLang)) {
    throw new Error(
      `Translatable config: defaultLang "${defaultLang}" not in langs ${JSON.stringify(config.langs)}`,
    );
  }
  return {
    langs: [...config.langs],
    defaultLang,
    fallbackOnMissing: config.fallbackOnMissing ?? true,
  };
}

/** Returns the names of translatable fields in a schema. */
export function translatableFieldNames(
  schema: Readonly<Record<string, SchemaField>>,
): readonly string[] {
  const names: string[] = [];
  for (const [name, def] of Object.entries(schema)) {
    if (isTranslatableField(def)) names.push(name);
  }
  return names;
}

/**
 * Rewrite a write record from the application shape (bare field names) to the
 * storage shape (`<field>_<lang>` for non-default langs). Untranslatable
 * fields and fields not present in the record are left untouched. When lang
 * is the default lang, no rewrite happens.
 *
 * The optional `lang` argument is the per-call override. When undefined, the
 * record is returned unchanged — callers writing in the default lang or
 * writing to specific lang columns explicitly (e.g. `{ title_fr: 'X' }`) can
 * skip this step.
 */
export function rewriteWriteRecord(
  record: Record<string, unknown>,
  schema: Readonly<Record<string, SchemaField>>,
  cfg: ResolvedTranslatableConfig | null,
  lang: string | undefined,
): Record<string, unknown> {
  if (!cfg || !lang || lang === cfg.defaultLang) return record;
  if (!cfg.langs.includes(lang)) return record;
  const out: Record<string, unknown> = { ...record };
  for (const [name, def] of Object.entries(schema)) {
    if (!isTranslatableField(def)) continue;
    if (!(name in record)) continue;
    const target = translatableColumnName(name, lang, cfg.defaultLang);
    if (target === name) continue;
    out[target] = record[name];
    delete out[name];
  }
  return out;
}

/**
 * Rewrite a read record from storage shape to application shape: replace
 * each translatable field's value with the active-lang column's value,
 * falling back to the default-lang column when null/undefined and
 * `fallbackOnMissing` is true.
 */
export function rewriteReadRecord(
  record: Record<string, unknown>,
  schema: Readonly<Record<string, SchemaField>>,
  cfg: ResolvedTranslatableConfig | null,
  lang: string | undefined,
): Record<string, unknown> {
  if (!cfg || !lang) return record;
  if (!cfg.langs.includes(lang)) return record;
  if (lang === cfg.defaultLang) return record;
  const out: Record<string, unknown> = { ...record };
  for (const [name, def] of Object.entries(schema)) {
    if (!isTranslatableField(def)) continue;
    const langKey = translatableColumnName(name, lang, cfg.defaultLang);
    const langValue = record[langKey];
    if (langValue !== null && langValue !== undefined && langValue !== '') {
      out[name] = langValue;
    } else if (!cfg.fallbackOnMissing) {
      out[name] = null;
    }
    // else: keep default-lang value (already in record under `name`)
  }
  return out;
}

/**
 * Rewrite a where-clause's translatable field references to the active-lang
 * column. `{ title: { eq: 'Bonjour' } }` with lang=fr becomes
 * `{ title_fr: { eq: 'Bonjour' } }`. Untranslatable fields are untouched.
 */
export function rewriteWhereClause(
  where: Record<string, unknown>,
  schema: Readonly<Record<string, SchemaField>>,
  cfg: ResolvedTranslatableConfig | null,
  lang: string | undefined,
): Record<string, unknown> {
  if (!cfg || !lang || lang === cfg.defaultLang) return where;
  if (!cfg.langs.includes(lang)) return where;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    const fieldDef = schema[key];
    if (fieldDef && isTranslatableField(fieldDef)) {
      out[translatableColumnName(key, lang, cfg.defaultLang)] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Per-language columns expected for a given schema. Used by SQLite/Postgres
 * adapters to provision DDL. The default-lang column keeps the bare name;
 * other langs gain `<field>_<lang>`.
 */
export function expandTranslatableColumns(
  schema: Readonly<Record<string, SchemaField>>,
  cfg: ResolvedTranslatableConfig | null,
): readonly { fieldName: string; columnName: string; lang: string; isDefault: boolean }[] {
  const expanded: { fieldName: string; columnName: string; lang: string; isDefault: boolean }[] = [];
  if (!cfg) return expanded;
  for (const [name, def] of Object.entries(schema)) {
    if (!isTranslatableField(def)) continue;
    for (const lang of cfg.langs) {
      expanded.push({
        fieldName: name,
        columnName: translatableColumnName(name, lang, cfg.defaultLang),
        lang,
        isDefault: lang === cfg.defaultLang,
      });
    }
  }
  return expanded;
}
