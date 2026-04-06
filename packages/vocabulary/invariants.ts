/**
 * Invariants — business constraints on an entity.
 *
 * Used in `.constrain([...])`. Invariants enforce rules that span multiple fields
 * or multiple entities — things that semantic type validation and lifecycle rules
 * cannot express alone.
 */

import { Created, Deleted, type EventDescriptor, Transitioned, Updated } from './event-descriptors';

export type InvariantSeverity = 'error' | 'warn';

/** Default events that trigger invariant checks: all mutation events. */
const ALL_MUTATIONS: readonly EventDescriptor[] = Object.freeze([
  Created,
  Updated,
  Deleted,
  Transitioned(),
]);

export interface InvariantDescriptor {
  readonly kind: 'invariant';
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: predicate operates on any entity record shape
  readonly predicate: (record: any, ctx: any) => boolean | Promise<boolean>;
  readonly on: readonly EventDescriptor[];
  readonly severity: InvariantSeverity;
}

/**
 * Declare a business invariant.
 *
 * ```typescript
 * Invariant('end must be after start',
 *   (record) => !record.endsAt || record.endsAt > record.startsAt)
 *
 * Invariant('capacity not exceeded',
 *   async (record, { dispatch }) => {
 *     const regs = await dispatch(Browse, { entity: 'registration', where: { eventId: record.id } });
 *     return regs.total < record.capacity;
 *   },
 *   { on: [Created] })
 * ```
 */
export function Invariant(
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: predicate operates on any entity record shape
  predicate: (record: any, ctx: any) => boolean | Promise<boolean>,
  options?: {
    on?: readonly EventDescriptor[];
    severity?: InvariantSeverity;
  },
): InvariantDescriptor {
  return Object.freeze({
    kind: 'invariant' as const,
    name,
    predicate,
    on: options?.on ?? ALL_MUTATIONS,
    severity: options?.severity ?? 'error',
  });
}
