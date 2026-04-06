/**
 * Classifications — what kind of VISIBILITY an entity has.
 *
 * Classification wraps the schema, producing the first argument to defineEntity():
 *   defineEntity('event', Public({ title: Str(), ... }))
 *
 * Classification is intrinsic — a property of the data, not of how it's projected.
 */

// ── The discriminated union ──────────────────────────────────────

export type Classification =
  | { readonly kind: 'public' }
  | { readonly kind: 'private' }
  | { readonly kind: 'sensitive' };

export type ClassificationKind = Classification['kind'];

// ── Classification constants (for switch cases) ─────────────────

export const PublicC = Object.freeze({ kind: 'public' as const });
export const PrivateC = Object.freeze({ kind: 'private' as const });
export const SensitiveC = Object.freeze({ kind: 'sensitive' as const });

// ── Classified schema (wraps the field map) ──────────────────────

export interface ClassifiedSchema<K extends ClassificationKind = ClassificationKind> {
  readonly classification: Classification & { readonly kind: K };
  readonly schema: Readonly<Record<string, unknown>>;
}

// ── Constructors ─────────────────────────────────────────────────

export function Public<S extends Record<string, unknown>>(
  schema: S,
): ClassifiedSchema<'public'> & { readonly schema: Readonly<S> } {
  return Object.freeze({
    classification: Object.freeze({ kind: 'public' as const }),
    schema: Object.freeze(schema),
  });
}

export function Private<S extends Record<string, unknown>>(
  schema: S,
): ClassifiedSchema<'private'> & { readonly schema: Readonly<S> } {
  return Object.freeze({
    classification: Object.freeze({ kind: 'private' as const }),
    schema: Object.freeze(schema),
  });
}

export function Sensitive<S extends Record<string, unknown>>(
  schema: S,
): ClassifiedSchema<'sensitive'> & { readonly schema: Readonly<S> } {
  return Object.freeze({
    classification: Object.freeze({ kind: 'sensitive' as const }),
    schema: Object.freeze(schema),
  });
}
