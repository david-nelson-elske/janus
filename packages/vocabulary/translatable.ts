/**
 * Translatable&lt;T&gt; — i18n wrapper for semantic fields.
 *
 * Marks a field as bearing per-language content. The store layer
 * provisions parallel `<name>` + `<name>_<lang>` columns at compile time;
 * the read pipeline resolves `record.<name>` against the active language
 * with fallback to the default language.
 *
 * Wrapping is opt-in per field. Existing schemas are untouched: a column
 * named `title` keeps its current shape; only translatable fields gain
 * extra columns. See ADR 125-00 §`@janus/store` (EXTEND).
 *
 * Usage:
 *   import { Translatable, Str, Markdown } from '@janus/vocabulary';
 *   define('news', {
 *     schema: {
 *       title: Translatable(Str({ required: true })),
 *       body:  Translatable(Markdown()),
 *       date:  DateTime(),
 *     },
 *   });
 *
 * Adapters detect TranslatableField via `isTranslatableField(field)` and
 * unwrap to `field.base` for type-driven decisions (column type, FTS
 * indexing, validation). The wrapper preserves all base hints — `required`,
 * `searchable`, etc. — so existing logic keeps working unchanged.
 */

import type { SemanticField } from './semantic-types';

export interface TranslatableField<T extends SemanticField = SemanticField> {
  readonly kind: 'translatable';
  readonly base: T;
}

export function Translatable<T extends SemanticField>(base: T): TranslatableField<T> {
  return Object.freeze({ kind: 'translatable' as const, base });
}

export function isTranslatableField(value: unknown): value is TranslatableField {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'translatable' &&
    'base' in value
  );
}

/**
 * Unwrap a translatable field to its base, or return the field unchanged
 * when not translatable. Useful in adapters that branch on `field.kind`
 * but want to treat translatable fields like their base type.
 */
export function unwrapTranslatable<T extends SemanticField>(
  field: T | TranslatableField<T>,
): T {
  return isTranslatableField(field) ? (field.base as T) : (field as T);
}

/**
 * Per-language column name for a translatable field. The default-language
 * column keeps its bare name, so adding French is purely additive: existing
 * `title` rows are unchanged; only `title_fr` is new.
 */
export function translatableColumnName(
  fieldName: string,
  lang: string,
  defaultLang: string,
): string {
  return lang === defaultLang ? fieldName : `${fieldName}_${lang}`;
}
