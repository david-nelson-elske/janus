/**
 * Invariant helpers — factory functions for common constraint patterns.
 *
 * These produce InvariantConfig objects for use with participate():
 *
 *   participate(event, {
 *     invariant: [
 *       TimeGate('startsAt', Days(1)),
 *       FieldCompare('startsAt', 'lt', 'endsAt'),
 *     ],
 *   })
 */

import type { InvariantConfig } from './types';

// ── Duration helpers ────────────────────────────────────────────

/** Convert hours to milliseconds. */
export function Hours(n: number): number {
  return n * 60 * 60 * 1000;
}

/** Convert days to milliseconds. */
export function Days(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

/** Convert minutes to milliseconds. */
export function Minutes(n: number): number {
  return n * 60 * 1000;
}

// ── TimeGate ────────────────────────────────────────────────────

export type TimeGateDirection = 'before' | 'since' | 'not-beyond';

export interface TimeGateOptions {
  readonly direction?: TimeGateDirection;
  readonly severity?: 'error' | 'warning';
  readonly message?: string;
}

/**
 * Enforce a DateTime field is at least/at most a duration from now.
 *
 * Directions:
 * - `'before'` (default): field must be >= duration in the future
 * - `'since'`:            field must be >= duration in the past
 * - `'not-beyond'`:       field must be <= duration in the future
 *
 * Examples:
 *   TimeGate('startsAt', Days(1))           — start must be >= 24h ahead
 *   TimeGate('startsAt', Hours(2), { direction: 'not-beyond' }) — start must be <= 2h ahead
 *   TimeGate('closedAt', Days(7), { direction: 'since' })       — closed must be >= 7d ago
 */
export function TimeGate(
  field: string,
  duration: number,
  opts?: TimeGateOptions,
): InvariantConfig {
  const direction = opts?.direction ?? 'before';

  const directionLabel =
    direction === 'before' ? 'at least' :
    direction === 'since' ? 'at least' :
    'at most';
  const timeLabel = formatDuration(duration);
  const frameLabel = direction === 'since' ? 'in the past' : 'in the future';
  const defaultMessage = `'${field}' must be ${directionLabel} ${timeLabel} ${frameLabel}`;

  return {
    name: `time-gate:${field}:${direction}`,
    severity: opts?.severity ?? 'error',
    message: opts?.message ?? defaultMessage,
    predicate: (record) => {
      const value = record[field];
      if (value === null || value === undefined) return true; // skip if not set

      const fieldTime = typeof value === 'string' ? new Date(value).getTime() : Number(value);
      if (Number.isNaN(fieldTime)) return true; // skip unparseable

      const now = Date.now();

      switch (direction) {
        case 'before':
          // Field must be >= duration in the future
          return fieldTime - now >= duration;
        case 'since':
          // Field must be >= duration in the past
          return now - fieldTime >= duration;
        case 'not-beyond':
          // Field must be <= duration in the future
          return fieldTime - now <= duration;
      }
    },
  };
}

// ── FieldCompare ────────────────────────────────────────────────

export type CompareOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';

export interface FieldCompareOptions {
  readonly severity?: 'error' | 'warning';
  readonly message?: string;
}

const OP_LABELS: Record<CompareOp, string> = {
  lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '==', neq: '!=',
};

/**
 * Assert a relationship between two fields on the same entity.
 *
 * Works with any comparable values (numbers, strings, dates).
 * Both fields must have values for the check to apply.
 *
 * Examples:
 *   FieldCompare('startsAt', 'lt', 'endsAt')    — start must be before end
 *   FieldCompare('minPrice', 'lte', 'maxPrice')  — min must be <= max
 */
export function FieldCompare(
  fieldA: string,
  op: CompareOp,
  fieldB: string,
  opts?: FieldCompareOptions,
): InvariantConfig {
  const defaultMessage = `'${fieldA}' must be ${OP_LABELS[op]} '${fieldB}'`;

  return {
    name: `field-compare:${fieldA}:${op}:${fieldB}`,
    severity: opts?.severity ?? 'error',
    message: opts?.message ?? defaultMessage,
    predicate: (record) => {
      const a = record[fieldA];
      const b = record[fieldB];
      if (a === null || a === undefined || b === null || b === undefined) return true;

      // Normalize to comparable values
      const va = typeof a === 'string' ? new Date(a).getTime() || a : a;
      const vb = typeof b === 'string' ? new Date(b).getTime() || b : b;

      switch (op) {
        case 'lt': return va < vb;
        case 'lte': return va <= vb;
        case 'gt': return va > vb;
        case 'gte': return va >= vb;
        case 'eq': return va === vb;
        case 'neq': return va !== vb;
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1 && days === Math.floor(days)) return `${days}d`;
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1 && hours === Math.floor(hours)) return `${hours}h`;
  const minutes = ms / (60 * 1000);
  if (minutes >= 1 && minutes === Math.floor(minutes)) return `${minutes}m`;
  return `${ms}ms`;
}
