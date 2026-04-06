/**
 * Audit levels — what mutation history is captured for an entity.
 *
 * Used in `.audit({ level: AuditFull, retain: days(90) })`.
 */

export type AuditLevel =
  | { readonly kind: 'full' }
  | { readonly kind: 'light' }
  | { readonly kind: 'none' };

export type AuditLevelKind = AuditLevel['kind'];

export const AuditFull = Object.freeze({ kind: 'full' as const });
export const AuditLight = Object.freeze({ kind: 'light' as const });
export const AuditNone = Object.freeze({ kind: 'none' as const });
