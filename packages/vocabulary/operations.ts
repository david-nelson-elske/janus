/**
 * Operations — what you DO to an entity.
 *
 * Operations are the request vocabulary. Every operation, on success,
 * produces a corresponding event descriptor.
 */

// ── The discriminated union ──────────────────────────────────────

export type Operation =
  | { readonly kind: 'browse' }
  | { readonly kind: 'get' }
  | { readonly kind: 'getById' }
  | { readonly kind: 'create' }
  | { readonly kind: 'update' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'transition'; readonly operation: string }
  | { readonly kind: 'act'; readonly name: string }
  | { readonly kind: 'process' };

export type OperationKind = Operation['kind'];

// ── Singleton constants ──────────────────────────────────────────

export const Browse = Object.freeze({ kind: 'browse' as const });
export const Get = Object.freeze({ kind: 'get' as const });
export const GetById = Object.freeze({ kind: 'getById' as const });
export const Create = Object.freeze({ kind: 'create' as const });
export const Update = Object.freeze({ kind: 'update' as const });
export const Delete = Object.freeze({ kind: 'delete' as const });
export const Process = Object.freeze({ kind: 'process' as const });

// ── Parameterized constructors ───────────────────────────────────

export function Transition(operation: string): Extract<Operation, { kind: 'transition' }> {
  return Object.freeze({ kind: 'transition' as const, operation });
}

export function Act(name: string): Extract<Operation, { kind: 'act' }> {
  return Object.freeze({ kind: 'act' as const, name });
}

// ── Type narrowing ───────────────────────────────────────────────

export function isTransitionOp(op: Operation): op is Extract<Operation, { kind: 'transition' }> {
  return op.kind === 'transition';
}

export function isActOp(op: Operation): op is Extract<Operation, { kind: 'act' }> {
  return op.kind === 'act';
}

// ── Category predicates ─────────────────────────────────────────

/** Read operations — no side effects, no before-record needed. */
export function isReadOp(op: Operation): boolean {
  return (
    op.kind === 'browse' || op.kind === 'get' || op.kind === 'getById' || op.kind === 'process'
  );
}

/**
 * Operations that require an existing record (ctx.before).
 *
 * Note: `act` is not included — whether an action needs a record depends on
 * its `scoped` flag, which the gate step checks directly.
 */
export function needsExistingRecord(op: Operation): boolean {
  return op.kind === 'update' || op.kind === 'delete' || op.kind === 'transition';
}
