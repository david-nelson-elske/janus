/**
 * Where clause filtering — ported from packages/next/store/filter.ts.
 *
 * STABLE — filter operators are an ADR-124 invariant. The operator set
 * ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $like, $null) matches
 * ADR 01c's operator-per-type table.
 */

import type { SortDirection } from '@janus/core';

export type PrimitiveValue = string | number | boolean | null;

export type FieldFilter = {
  readonly $eq?: PrimitiveValue;
  readonly $ne?: PrimitiveValue;
  readonly $gt?: PrimitiveValue;
  readonly $gte?: PrimitiveValue;
  readonly $lt?: PrimitiveValue;
  readonly $lte?: PrimitiveValue;
  readonly $in?: readonly PrimitiveValue[];
  readonly $nin?: readonly PrimitiveValue[];
  readonly $like?: string;
  readonly $null?: boolean;
};

export type WhereClause = Record<string, FieldFilter | PrimitiveValue | readonly PrimitiveValue[]>;

export function isOperatorObject(value: unknown): value is FieldFilter {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((k) => k.startsWith('$'))
  );
}

export function matchesWhere(record: Record<string, unknown>, where: WhereClause): boolean {
  for (const [field, filter] of Object.entries(where)) {
    if (field === '_deleted') continue;

    const rv = record[field];

    if (filter === null) {
      if (rv != null) return false;
    } else if (Array.isArray(filter)) {
      if (!filter.includes(rv as PrimitiveValue)) return false;
    } else if (isOperatorObject(filter)) {
      if (!matchesFieldFilter(rv, filter)) return false;
    } else {
      if (rv !== filter) return false;
    }
  }
  return true;
}

export function matchesFieldFilter(value: unknown, filter: FieldFilter): boolean {
  if (filter.$eq !== undefined && value !== filter.$eq) return false;
  if (filter.$ne !== undefined && value === filter.$ne) return false;
  if (filter.$gt !== undefined && !(compare(value, filter.$gt) > 0)) return false;
  if (filter.$gte !== undefined && !(compare(value, filter.$gte) >= 0)) return false;
  if (filter.$lt !== undefined && !(compare(value, filter.$lt) < 0)) return false;
  if (filter.$lte !== undefined && !(compare(value, filter.$lte) <= 0)) return false;
  if (filter.$in !== undefined && !filter.$in.includes(value as PrimitiveValue)) return false;
  if (filter.$nin !== undefined && filter.$nin.includes(value as PrimitiveValue)) return false;
  if (filter.$like !== undefined) {
    if (typeof value !== 'string') return false;
    if (!matchLike(value, filter.$like)) return false;
  }
  if (filter.$null !== undefined) {
    if (filter.$null && value != null) return false;
    if (!filter.$null && value == null) return false;
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matchLike(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(value);
}

export function compareValues(a: unknown, b: unknown, direction: SortDirection): number {
  const result = compare(a, b);
  return direction === 'asc' ? result : -result;
}
