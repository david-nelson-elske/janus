/**
 * schema-parse — Schema-driven input parsing and coercion.
 *
 * STABLE — parse logic is an ADR-05 invariant. Coerces input fields to match
 * semantic types, strips unknown fields, checks required fields on create.
 */

import { isSemanticField, isLifecycle, isWiringType, isTranslatableField, unwrapTranslatable } from '@janus/vocabulary';
import type { ExecutionHandler } from '@janus/core';

export const schemaParse: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  if (!entity) return;

  // Use ctx.parsed if already set by an upstream handler (e.g., http-receive),
  // otherwise fall back to ctx.input (direct dispatch path).
  const input = (ctx.parsed ?? ctx.input) as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') {
    ctx.parsed = {};
    return;
  }

  const parsed: Record<string, unknown> = {};
  const schema = entity.schema;

  // Collect per-language sibling keys for Translatable fields so callers
  // can write `{ title: 'EN', title_fr: 'FR' }` in a single dispatch and
  // have the parallel column populated. The base field's required-check
  // and type-coercion apply to each sibling individually.
  const translatableBases = new Map<string, string>(); // base name → semantic kind
  for (const [field, fieldDef] of Object.entries(schema)) {
    if (isTranslatableField(fieldDef)) {
      const base = unwrapTranslatable(fieldDef);
      if (isSemanticField(base)) translatableBases.set(field, base.kind);
    }
  }

  for (const [field, fieldDef] of Object.entries(schema)) {
    // Unwrap translatable wrapper so semantic-field handling below applies
    // to its base type (Str / Markdown / etc.). Without this the bare
    // translatable value gets stripped from `parsed` and any update never
    // reaches the store layer (defeated the lang forwarding chain).
    const effective = isTranslatableField(fieldDef)
      ? unwrapTranslatable(fieldDef)
      : fieldDef;
    if (!(field in input)) {
      // Check required on create
      if (
        ctx.operation === 'create' &&
        isSemanticField(effective) &&
        effective.hints?.required
      ) {
        throw Object.assign(new Error(`Required field '${field}' is missing`), {
          kind: 'parse-error',
          retryable: false,
        });
      }
      continue;
    }

    const value = input[field];

    // Coerce types
    if (isSemanticField(effective)) {
      parsed[field] = coerceValue(value, effective.kind);
    } else if (isLifecycle(effective) || isWiringType(effective)) {
      parsed[field] = value;
    }
  }

  // Pass through `<base>_<lang>` siblings of Translatable fields. We don't
  // know the i18n config here, so we accept any suffix — the adapter
  // ultimately decides which columns exist (unknown columns hard-error
  // there, which is the right surface for typos like `title_xx`).
  for (const key of Object.keys(input)) {
    if (key in schema || key === 'id') continue;
    const underscore = key.lastIndexOf('_');
    if (underscore <= 0) continue;
    const base = key.slice(0, underscore);
    const baseKind = translatableBases.get(base);
    if (!baseKind) continue;
    parsed[key] = coerceValue(input[key], baseKind);
  }

  // id is always passed through for update/delete
  if ('id' in input) {
    parsed.id = input.id;
  }

  ctx.parsed = parsed;
};

function coerceValue(value: unknown, kind: string): unknown {
  if (value === null || value === undefined) return value;

  switch (kind) {
    case 'int':
    case 'intCents':
    case 'intBps':
    case 'duration':
      return typeof value === 'string' ? Number.parseInt(value, 10) : value;
    case 'float':
      return typeof value === 'string' ? Number.parseFloat(value) : value;
    case 'bool':
      if (typeof value === 'string') return value === 'true' || value === '1';
      return value;
    default:
      return value;
  }
}
