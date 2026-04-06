/**
 * @janus/client — Signal-based binding primitives.
 *
 * Framework-agnostic reactive state for entity views.
 */

export { createFieldState } from './field-state';
export type { FieldState, FieldMeta } from './field-state';

export { createBindingContext, createBindingContextFromRegistry } from './binding-context';
export type { BindingContext } from './binding-context';

export { serializeBindingContext, serializeInitData } from './serialize';
export type { SerializedBindingContext, SerializedFieldState, JanusInitData } from './serialize';

export { createBindingRegistry } from './binding-registry';
export type { BindingRegistry } from './binding-registry';

export { updateBindingContexts, removeFromBindingContexts } from './update-contexts';

export { createDispatchEntity, saveContext } from './dispatch-helper';
export type { DispatchEntityFn, DispatchResult, DispatchEntityConfig } from './dispatch-helper';
