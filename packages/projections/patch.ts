/**
 * Minimal JSON Patch (RFC 6902) diff for composed projection views.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §9 — JSON Patch is the
 * default diff format because the doc tree has reorderable sections,
 * entries, and items, and Merge Patch can't express array moves.
 *
 * Phase 0 scope: produce a correct (not optimal) patch. We emit
 * `replace` for primitive changes, `add` / `remove` for array growth
 * and shrinkage, and recurse into objects + arrays. Move detection,
 * minimum-edit-distance array diffing, and shape-aware key reuse are
 * deferred to v3.
 */

import type { ComposedValue } from './types';

export interface PatchOpAdd {
  readonly op: 'add';
  readonly path: string;
  readonly value: unknown;
}

export interface PatchOpRemove {
  readonly op: 'remove';
  readonly path: string;
}

export interface PatchOpReplace {
  readonly op: 'replace';
  readonly path: string;
  readonly value: unknown;
}

export type JsonPatchOp = PatchOpAdd | PatchOpRemove | PatchOpReplace;

export type JsonPatch = readonly JsonPatchOp[];

/**
 * Diff `prev` against `next`, returning the operations that transform
 * `prev` into `next`. `path` is the RFC 6902 pointer (`/sections/0/title`).
 * The top-level pointer is `''` and nested keys are slash-prefixed.
 */
export function diff(prev: unknown, next: unknown, path = ''): JsonPatchOp[] {
  if (prev === next) return [];
  if (!isPlainObject(prev) && !Array.isArray(prev)) {
    if (!deepEqual(prev, next)) {
      return [{ op: 'replace', path: path || '', value: next }];
    }
    return [];
  }
  if (Array.isArray(prev)) {
    if (!Array.isArray(next)) {
      return [{ op: 'replace', path: path || '', value: next }];
    }
    return diffArray(prev, next, path);
  }
  if (!isPlainObject(next)) {
    return [{ op: 'replace', path: path || '', value: next }];
  }
  return diffObject(prev as Record<string, unknown>, next as Record<string, unknown>, path);
}

function diffObject(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (const key of Object.keys(prev)) {
    if (!(key in next)) {
      ops.push({ op: 'remove', path: joinPath(path, key) });
    }
  }
  for (const key of Object.keys(next)) {
    if (!(key in prev)) {
      ops.push({ op: 'add', path: joinPath(path, key), value: next[key] });
      continue;
    }
    ops.push(...diff(prev[key], next[key], joinPath(path, key)));
  }
  return ops;
}

function diffArray(prev: unknown[], next: unknown[], path: string): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  const common = Math.min(prev.length, next.length);
  for (let i = 0; i < common; i++) {
    ops.push(...diff(prev[i], next[i], joinPath(path, String(i))));
  }
  if (next.length > prev.length) {
    for (let i = prev.length; i < next.length; i++) {
      // Use "/-" idiom for appends per RFC 6902 §4.1; appending values
      // one-by-one is simpler than emitting a single batched add.
      ops.push({ op: 'add', path: `${path}/-`, value: next[i] });
    }
  } else if (prev.length > next.length) {
    for (let i = prev.length - 1; i >= next.length; i--) {
      ops.push({ op: 'remove', path: joinPath(path, String(i)) });
    }
  }
  return ops;
}

function joinPath(parent: string, child: string): string {
  return `${parent}/${escapeSegment(child)}`;
}

/** RFC 6902 §3 escaping: `~` → `~0`, `/` → `~1`. */
function escapeSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/**
 * Convenience: a typed `diff` for composed projection values.
 */
export function diffComposed(prev: ComposedValue, next: ComposedValue): JsonPatch {
  return diff(prev, next, '');
}
