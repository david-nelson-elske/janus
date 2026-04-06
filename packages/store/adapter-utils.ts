/**
 * Shared adapter utilities — logic used by both memory and SQLite adapters.
 *
 * STABLE — these are derived from storage strategy semantics (ADR-124).
 */

import { isPersistent, isSingleton } from '@janus/vocabulary';
import type { AdapterMeta } from './store-adapter';

/** Persistent and Singleton entities use soft delete (_deletedAt timestamp). */
export function useSoftDelete(meta: AdapterMeta): boolean {
  return isPersistent(meta.storage) || isSingleton(meta.storage);
}
