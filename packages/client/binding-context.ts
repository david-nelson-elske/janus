/**
 * BindingContext — Per-entity-view reactive state.
 *
 * Created from a BindingRecord + entity data record + schema.
 * Only fields listed in binding.config.fields are included.
 */

import { computed } from '@preact/signals-core';
import type { ReadonlySignal } from '@preact/signals-core';
import type { BindingRecord, CompileResult, SchemaField } from '@janus/core';
import type { FieldState, FieldMeta } from './field-state';
import { createFieldState } from './field-state';

export interface BindingContext {
  readonly entity: string;
  readonly id: string | null;               // null for list/collection views
  readonly view: string;
  readonly fields: Readonly<Record<string, FieldState>>;
  readonly dirty: ReadonlySignal<boolean>;  // true if any field is dirty
}

/**
 * Create a BindingContext from a registry + view name (looks up binding and schema automatically).
 * Throws if the entity or binding is not found.
 */
export function createBindingContextFromRegistry(
  registry: CompileResult,
  entity: string,
  id: string | null,
  view: string,
  record: Record<string, unknown>,
): BindingContext {
  const binding = registry.bindingIndex.byEntityAndView(entity, view);
  if (!binding) {
    throw new Error(`No binding for entity '${entity}' view '${view}'`);
  }
  const node = registry.entity(entity);
  if (!node) {
    throw new Error(`Unknown entity '${entity}'`);
  }
  return createBindingContext(entity, id, view, binding, record, node.schema);
}

export function createBindingContext(
  entity: string,
  id: string | null,
  view: string,
  binding: BindingRecord,
  record: Record<string, unknown>,
  schema: Record<string, SchemaField>,
): BindingContext {
  const fields: Record<string, FieldState> = {};

  if (binding.config.fields) {
    for (const [fieldName, fieldConfig] of Object.entries(binding.config.fields)) {
      const value = record[fieldName] ?? null;
      const schemaField = schema[fieldName];
      const type = schemaField ? schemaField.kind : 'unknown';

      const meta: FieldMeta = {
        type,
        agent: fieldConfig.agent,
        component: fieldConfig.component,
        label: fieldConfig.label,
      };

      fields[fieldName] = createFieldState(value, meta);
    }
  }

  const frozenFields = Object.freeze(fields);
  const fieldStates = Object.values(frozenFields);
  const dirty = computed(() => fieldStates.some((f) => f.dirty.value));

  return Object.freeze({
    entity,
    id,
    view,
    fields: frozenFields,
    dirty,
  });
}
