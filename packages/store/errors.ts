/**
 * Structured store errors.
 *
 * STABLE — ported from packages/next/store/errors.ts.
 */

export type StoreError =
  | { readonly kind: 'not-found'; readonly entity: string; readonly id: string }
  | {
      readonly kind: 'conflict';
      readonly entity: string;
      readonly id: string;
      readonly field?: string;
    }
  | {
      readonly kind: 'version-conflict';
      readonly entity: string;
      readonly id: string;
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly kind: 'read-only'; readonly entity: string; readonly operation: string }
  | { readonly kind: 'invalid-query'; readonly entity: string; readonly detail: string }
  | {
      readonly kind: 'constraint-violation';
      readonly entity: string;
      readonly constraint: string;
      readonly detail?: string;
    }
  | { readonly kind: 'transaction-failed'; readonly entity: string; readonly reason: string };

export class StoreException extends Error {
  readonly error: StoreError;
  readonly kind: string;
  constructor(error: StoreError) {
    super(formatStoreError(error));
    this.name = 'StoreException';
    this.error = error;
    this.kind = error.kind;
  }
}

function formatStoreError(error: StoreError): string {
  switch (error.kind) {
    case 'not-found':
      return `Entity '${error.entity}' record '${error.id}' not found`;
    case 'conflict':
      return `Entity '${error.entity}' record '${error.id}' conflict${error.field ? ` on field '${error.field}'` : ''}`;
    case 'version-conflict':
      return `Entity '${error.entity}' record '${error.id}' version conflict: expected ${error.expected}, actual ${error.actual}`;
    case 'read-only':
      return `Entity '${error.entity}' is read-only, cannot ${error.operation}`;
    case 'invalid-query':
      return `Invalid query on '${error.entity}': ${error.detail}`;
    case 'constraint-violation':
      return `Entity '${error.entity}' constraint '${error.constraint}' violated${error.detail ? `: ${error.detail}` : ''}`;
    case 'transaction-failed':
      return `Transaction failed on '${error.entity}': ${error.reason}`;
  }
}

export function entityNotFound(entity: string, id: string): StoreException {
  return new StoreException({ kind: 'not-found', entity, id });
}

export function versionConflict(
  entity: string,
  id: string,
  expected: number,
  actual: number,
): StoreException {
  return new StoreException({ kind: 'version-conflict', entity, id, expected, actual });
}

export function readOnlyEntity(entity: string, operation: string): StoreException {
  return new StoreException({ kind: 'read-only', entity, operation });
}
