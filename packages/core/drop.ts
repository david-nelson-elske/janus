/**
 * drop() — Acknowledge entity removal for schema reconciliation (ADR 04c).
 *
 * When an entity is removed from define() declarations, the reconciliation
 * pipeline blocks with an error unless a drop() declaration is provided.
 */

import type { DropResult } from './types';

export function drop(entity: string): DropResult {
  return Object.freeze({ kind: 'drop' as const, entity });
}
