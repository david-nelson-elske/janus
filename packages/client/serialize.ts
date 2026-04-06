/**
 * Serialize / deserialize binding contexts for SSR transfer.
 *
 * SSR renders the page server-side, then embeds serialized binding context
 * data in window.__JANUS__. The client recreates live signals from this data.
 */

import type { BindingContext } from './binding-context';
import type { FieldMeta } from './field-state';

/** Serialized form of a BindingContext — no signals, just plain values. */
export interface SerializedBindingContext {
  readonly entity: string;
  readonly id: string | null;
  readonly view: string;
  readonly fields: Record<string, SerializedFieldState>;
}

export interface SerializedFieldState {
  readonly value: unknown;
  readonly meta: FieldMeta;
}

/** Serialized init data embedded in window.__JANUS__. */
export interface JanusInitData {
  readonly contexts: readonly SerializedBindingContext[];
  readonly cursor?: string;
}

/**
 * Serialize a BindingContext to plain JSON (for embedding in HTML).
 * Reads current committed values from signals.
 */
export function serializeBindingContext(ctx: BindingContext): SerializedBindingContext {
  const fields: Record<string, SerializedFieldState> = {};
  for (const [name, field] of Object.entries(ctx.fields)) {
    fields[name] = {
      value: field.committed.value,
      meta: field.meta,
    };
  }
  return { entity: ctx.entity, id: ctx.id, view: ctx.view, fields };
}

/**
 * Serialize multiple contexts for SSR transfer.
 */
export function serializeInitData(
  contexts: readonly BindingContext[],
  cursor?: string,
): JanusInitData {
  return {
    contexts: contexts.map(serializeBindingContext),
    cursor,
  };
}
