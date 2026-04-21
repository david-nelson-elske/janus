/**
 * bind() — Presentation binding wiring.
 *
 * Produces BindingRecords from BindingInput[].
 * Each binding maps a component to a view of an entity with field-level config.
 *
 * STABLE — bind() is the consumer API for presentation wiring (ADR 10).
 */

import type {
  BindingInput,
  BindingRecord,
  BindResult,
  DefineResult,
} from './types';
import { resolveEntityName } from './types';

export function bind(
  entity: string | DefineResult,
  bindings: readonly BindingInput[],
): BindResult {
  const entityName = resolveEntityName(entity);

  const records: BindingRecord[] = bindings.map((input) => {
    const fields = input.config.fields
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(input.config.fields).map(([k, v]) => [k, Object.freeze({ ...v })]),
          ),
        )
      : undefined;

    const config = Object.freeze({
      fields,
      columns: input.config.columns ? Object.freeze([...input.config.columns]) : undefined,
      layout: input.config.layout,
      title: input.config.title,
      loader: input.config.loader,
    });

    return Object.freeze({
      source: entityName,
      component: input.component,
      view: input.view,
      config,
    });
  });

  return Object.freeze({
    kind: 'bind' as const,
    records: Object.freeze(records),
  });
}
