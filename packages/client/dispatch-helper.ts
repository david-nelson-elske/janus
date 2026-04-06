/**
 * Dispatch helper — client-side mutations via HTTP.
 *
 * Provides createDispatchEntity() for posting operations to the API,
 * and saveContext() for saving dirty binding context fields.
 */

import type { BindingContext } from './binding-context';

export interface DispatchEntityConfig {
  readonly baseUrl: string;
  readonly auth?: () => Promise<string> | string;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { kind: string; message: string };
}

export type DispatchEntityFn = (
  entity: string,
  operation: string,
  input: Record<string, unknown>,
) => Promise<DispatchResult>;

/**
 * Create a dispatch function for client-side mutations.
 */
export function createDispatchEntity(config: DispatchEntityConfig): DispatchEntityFn {
  const base = config.baseUrl.replace(/\/$/, '');

  return async (entity, operation, input) => {
    const plural = `${entity}s`;
    let method: string;
    let url: string;
    const id = input.id as string | undefined;

    switch (operation) {
      case 'create':
        method = 'POST';
        url = `${base}/${plural}`;
        break;
      case 'update':
        method = 'PATCH';
        url = `${base}/${plural}/${id}`;
        break;
      case 'delete':
        method = 'DELETE';
        url = `${base}/${plural}/${id}`;
        break;
      default:
        // Lifecycle transition or action
        method = 'POST';
        url = `${base}/${plural}/${id}/${operation}`;
        break;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth) {
      const token = await config.auth();
      if (token) headers['X-API-Key'] = token;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method !== 'DELETE' ? JSON.stringify(input) : undefined,
      });

      if (res.status === 204) {
        return { ok: true };
      }

      const json = await res.json();
      return {
        ok: json.ok ?? false,
        data: json.data,
        error: json.error,
      };
    } catch (err) {
      return {
        ok: false,
        error: { kind: 'network', message: (err as Error).message },
      };
    }
  };
}

/**
 * Save dirty fields from a binding context.
 * Collects dirty read-write fields and dispatches an update.
 */
export async function saveContext(
  ctx: BindingContext,
  dispatch: DispatchEntityFn,
): Promise<DispatchResult | undefined> {
  const patch: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(ctx.fields)) {
    if (field.dirty.value && field.meta.agent === 'read-write') {
      patch[name] = field.current.value;
    }
  }

  if (Object.keys(patch).length === 0) return undefined;

  const result = await dispatch(ctx.entity, 'update', { id: ctx.id, ...patch });

  // On success, update committed values to match server response
  if (result.ok && result.data) {
    for (const [name, value] of Object.entries(result.data)) {
      const field = ctx.fields[name];
      if (field) {
        field.committed.value = value;
      }
    }
  }

  return result;
}
