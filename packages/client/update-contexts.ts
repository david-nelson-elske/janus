/**
 * SSE → signal bridge.
 *
 * When the server pushes an entity change, update committed signal values
 * on matching binding contexts. Dirty fields are preserved — committed
 * updates but current does not, so user edits are not overwritten.
 */

import type { BindingContext } from './binding-context';
import type { FieldState } from './field-state';

/**
 * Update binding contexts when an entity record changes (from SSE push).
 * Updates committed values. Only updates current if the field is not dirty.
 */
export function updateBindingContexts(
  contexts: readonly BindingContext[],
  entity: string,
  id: string,
  record: Record<string, unknown>,
): void {
  for (const ctx of contexts) {
    if (ctx.entity !== entity) continue;

    // Detail view: update if id matches
    if (ctx.id === id) {
      updateFields(ctx.fields, record);
    }
  }
}

/**
 * Remove a deleted entity from binding contexts.
 * For list views this would remove the row; for detail views it signals deletion.
 */
export function removeFromBindingContexts(
  contexts: readonly BindingContext[],
  entity: string,
  _id: string,
): void {
  // For now, detail views don't auto-navigate away on delete.
  // List views will re-fetch on next navigation.
  // This is a placeholder for future list-level reactivity.
  void contexts;
  void entity;
}

function updateFields(
  fields: Readonly<Record<string, FieldState>>,
  record: Record<string, unknown>,
): void {
  for (const [fieldName, value] of Object.entries(record)) {
    const field = fields[fieldName];
    if (!field) continue;

    // Check dirty BEFORE updating committed (updating committed changes dirty)
    const wasDirty = field.dirty.value;

    // Always update committed
    field.committed.value = value;

    // Only update current if field was not dirty (preserves user edits)
    if (!wasDirty) {
      field.current.value = value;
    }
  }
}
