/**
 * Keyset cursor encoding/decoding for stable pagination.
 *
 * STABLE — ported from packages/next/store/cursor.ts.
 */

import type { SortDirection } from '@janus/core';

export interface CursorPayload {
  readonly v: unknown;
  readonly id: string;
  readonly d: SortDirection;
}

export function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload));
}

export function decodeCursor(token: string): CursorPayload {
  return JSON.parse(atob(token)) as CursorPayload;
}
