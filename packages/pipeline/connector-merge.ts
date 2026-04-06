/**
 * Connector merge utilities — per-field ownership for bidirectional sync (ADR 07c).
 *
 * Pure functions for merging entity records based on field ownership maps.
 * A field ownership map declares which system owns each field:
 *   { "name": "source", "email": "local", "phone": "source" }
 *
 * - "source" → external system owns → overwrite on ingest, skip on distribute
 * - "local"  → local system owns → skip on ingest, include on distribute
 */

export type FieldOwner = 'source' | 'local';
export type FieldOwnershipMap = Readonly<Record<string, FieldOwner>>;

export interface MergeResult {
  /** The merged record (local fields preserved, source fields overwritten). */
  readonly merged: Record<string, unknown>;
  /** Field names that changed during merge. */
  readonly changed: readonly string[];
}

export interface DistributeFilterResult {
  /** Only the local-owned fields (safe to push to external system). */
  readonly fields: Record<string, unknown>;
  /** Whether any pushable fields exist. */
  readonly hasPushableFields: boolean;
}

// Reserved metadata fields that should never be merged or pushed.
const RESERVED = new Set([
  'id', '_version', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', '_deletedAt',
]);

/**
 * Merge external data into a local record using field ownership.
 *
 * - Source-owned fields: take the external value (overwrite local)
 * - Local-owned fields: keep the local value (ignore external)
 * - No ownership map: all non-reserved fields are source-owned (backward compat)
 */
export function mergeOnIngest(
  local: Readonly<Record<string, unknown>>,
  external: Readonly<Record<string, unknown>>,
  ownership?: FieldOwnershipMap,
): MergeResult {
  const merged: Record<string, unknown> = { ...local };
  const changed: string[] = [];

  if (!ownership) {
    // No ownership map → all external fields overwrite (source-owned)
    for (const [key, value] of Object.entries(external)) {
      if (RESERVED.has(key)) continue;
      if (merged[key] !== value) {
        changed.push(key);
      }
      merged[key] = value;
    }
    return { merged, changed };
  }

  for (const [key, value] of Object.entries(external)) {
    if (RESERVED.has(key)) continue;
    const owner = ownership[key];
    // Source-owned or unspecified fields from external data → overwrite
    if (owner === 'source' || owner === undefined) {
      if (merged[key] !== value) {
        changed.push(key);
      }
      merged[key] = value;
    }
    // Local-owned → skip (keep local value)
  }

  return { merged, changed };
}

/**
 * Filter a record's fields for distribute (push to external system).
 *
 * - Local-owned fields: include (these are authoritative locally)
 * - Source-owned fields: exclude (external system owns them)
 * - No ownership map: all non-reserved fields included (backward compat)
 */
export function filterForDistribute(
  record: Readonly<Record<string, unknown>>,
  ownership?: FieldOwnershipMap,
): DistributeFilterResult {
  const fields: Record<string, unknown> = {};

  if (!ownership) {
    // No ownership map → include all non-reserved fields
    for (const [key, value] of Object.entries(record)) {
      if (RESERVED.has(key)) continue;
      fields[key] = value;
    }
    return { fields, hasPushableFields: Object.keys(fields).length > 0 };
  }

  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key)) continue;
    const owner = ownership[key];
    // Local-owned or unspecified → include for push
    if (owner === 'local' || owner === undefined) {
      fields[key] = value;
    }
    // Source-owned → skip (external system owns it)
  }

  return { fields, hasPushableFields: Object.keys(fields).length > 0 };
}

/**
 * Check if an external update is stale relative to the binding watermark.
 *
 * Returns true if the binding's watermark is >= the external timestamp,
 * meaning this external data predates our last sync (likely a ping-pong bounce).
 */
export function isPingPong(
  bindingWatermark: string | null | undefined,
  externalTimestamp: string,
): boolean {
  if (!bindingWatermark) return false;
  return externalTimestamp <= bindingWatermark;
}
