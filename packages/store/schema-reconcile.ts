/**
 * Schema reconciliation — four-tier change classification and migration (ADR 04c).
 *
 * Pipeline: read snapshot → diff → classify → resolve → apply → update snapshot → report.
 *
 * Tiers:
 *   safe         — auto-applied, no consumer input needed
 *   cautious     — auto-applied IF consumer provides evolve config (renames, backfills, coercions)
 *   destructive  — auto-applied IF consumer explicitly acknowledges (evolve.drops, drop())
 *   ambiguous    — always blocked until consumer disambiguates
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { EvolveConfig } from '@janus/core';
import type { AdapterMeta } from './store-adapter';
import type { EntitySnapshot, SchemaSnapshotStore } from './schema-snapshot';
import { generateSnapshot } from './schema-snapshot';
import { tableName } from './schema-gen';

// ── Types ───────────────────────────────────────────────────────

export type ChangeTier = 'safe' | 'cautious' | 'destructive' | 'ambiguous';

export type ChangeKind =
  | 'add-column'
  | 'remove-column'
  | 'rename-column'
  | 'add-entity'
  | 'remove-entity'
  | 'change-type'
  | 'change-nullability'
  | 'add-lifecycle-state'
  | 'remove-lifecycle-state';

export interface SchemaChange {
  readonly entity: string;
  readonly tier: ChangeTier;
  readonly kind: ChangeKind;
  readonly field?: string;
  readonly description: string;
  /** Present when the consumer has provided the needed evolve config to resolve this change. */
  readonly resolution?: string;
}

export interface ReconciliationPlan {
  readonly changes: readonly SchemaChange[];
  readonly safe: readonly SchemaChange[];
  readonly cautious: readonly SchemaChange[];
  readonly destructive: readonly SchemaChange[];
  readonly ambiguous: readonly SchemaChange[];
  /** True when every non-safe change has a resolution — the pipeline can apply everything. */
  readonly canAutoApply: boolean;
}

export interface ReconciliationReport {
  readonly applied: readonly SchemaChange[];
  readonly timestamp: string;
}

// ── Classification ──────────────────────────────────────────────

export function classifyChanges(
  current: readonly AdapterMeta[],
  snapshots: readonly EntitySnapshot[],
  evolveConfigs: ReadonlyMap<string, EvolveConfig>,
  drops: ReadonlySet<string>,
): ReconciliationPlan {
  const snapshotMap = new Map(snapshots.map((s) => [s.entity, s]));
  const currentMap = new Map(current.map((m) => [m.entity, m]));
  const changes: SchemaChange[] = [];

  // New entities (in current, not in snapshot)
  for (const meta of current) {
    if (!snapshotMap.has(meta.entity)) {
      changes.push({
        entity: meta.entity, tier: 'safe', kind: 'add-entity',
        description: `New entity '${meta.entity}' — CREATE TABLE`,
      });
    }
  }

  // Removed entities (in snapshot, not in current)
  for (const snapshot of snapshots) {
    if (!currentMap.has(snapshot.entity)) {
      if (drops.has(snapshot.entity)) {
        changes.push({
          entity: snapshot.entity, tier: 'destructive', kind: 'remove-entity',
          description: `Entity '${snapshot.entity}' removed — acknowledged via drop()`,
          resolution: 'drop()',
        });
      } else {
        changes.push({
          entity: snapshot.entity, tier: 'ambiguous', kind: 'remove-entity',
          description: `Entity '${snapshot.entity}' removed — add drop('${snapshot.entity}') to acknowledge`,
        });
      }
    }
  }

  // Changed entities (in both — diff fields)
  for (const meta of current) {
    const snapshot = snapshotMap.get(meta.entity);
    if (!snapshot) continue;
    classifyEntityChanges(meta, snapshot, evolveConfigs.get(meta.entity), changes);
  }

  const safe = changes.filter((c) => c.tier === 'safe');
  const cautious = changes.filter((c) => c.tier === 'cautious');
  const destructive = changes.filter((c) => c.tier === 'destructive');
  const ambiguous = changes.filter((c) => c.tier === 'ambiguous');

  const canAutoApply =
    ambiguous.length === 0 &&
    cautious.every((c) => c.resolution !== undefined) &&
    destructive.every((c) => c.resolution !== undefined);

  return Object.freeze({ changes, safe, cautious, destructive, ambiguous, canAutoApply });
}

function classifyEntityChanges(
  meta: AdapterMeta,
  snapshot: EntitySnapshot,
  evolve: EvolveConfig | undefined,
  changes: SchemaChange[],
): void {
  const snapshotFields = new Map(snapshot.fields.map((f) => [f.name, f]));
  const desiredSnapshot = generateSnapshot(meta);
  const desiredFields = new Map(desiredSnapshot.fields.map((f) => [f.name, f]));

  // Build rename lookup: new name → old name
  const renameNewToOld = new Map<string, string>();
  if (evolve?.renames) {
    for (const [oldName, newName] of Object.entries(evolve.renames)) {
      renameNewToOld.set(newName, oldName);
    }
  }

  // Added fields
  for (const [name, field] of desiredFields) {
    if (snapshotFields.has(name)) continue;

    const oldName = renameNewToOld.get(name);
    if (oldName && snapshotFields.has(oldName)) {
      changes.push({
        entity: meta.entity, tier: 'cautious', kind: 'rename-column', field: name,
        description: `Rename '${oldName}' → '${name}' on '${meta.entity}'`,
        resolution: `evolve.renames.${oldName}`,
      });
      continue;
    }

    if (field.required && evolve?.backfills?.[name] === undefined) {
      changes.push({
        entity: meta.entity, tier: 'cautious', kind: 'add-column', field: name,
        description: `Add required column '${name}' to '${meta.entity}' — provide evolve.backfills.${name}`,
      });
    } else {
      changes.push({
        entity: meta.entity, tier: 'safe', kind: 'add-column', field: name,
        description: field.required
          ? `Add required column '${name}' to '${meta.entity}' (backfill provided)`
          : `Add nullable column '${name}' to '${meta.entity}'`,
        resolution: field.required ? `evolve.backfills.${name}` : undefined,
      });
    }
  }

  // Removed fields
  for (const [name] of snapshotFields) {
    if (desiredFields.has(name)) continue;
    if (evolve?.renames?.[name]) continue;

    if (evolve?.drops?.includes(name)) {
      changes.push({
        entity: meta.entity, tier: 'destructive', kind: 'remove-column', field: name,
        description: `Drop column '${name}' from '${meta.entity}' — acknowledged via evolve.drops`,
        resolution: 'evolve.drops',
      });
    } else {
      changes.push({
        entity: meta.entity, tier: 'ambiguous', kind: 'remove-column', field: name,
        description: `Column '${name}' removed from '${meta.entity}' — add to evolve.drops or evolve.renames`,
      });
    }
  }

  // Type changes
  for (const [name, desired] of desiredFields) {
    const existing = snapshotFields.get(name);
    if (!existing) continue;
    if (desired.sqlType !== existing.sqlType) {
      if (evolve?.coercions?.[name]) {
        changes.push({
          entity: meta.entity, tier: 'cautious', kind: 'change-type', field: name,
          description: `Type change on '${name}' (${existing.sqlType} → ${desired.sqlType}) — coercion provided`,
          resolution: `evolve.coercions.${name}`,
        });
      } else {
        changes.push({
          entity: meta.entity, tier: 'ambiguous', kind: 'change-type', field: name,
          description: `Type change on '${name}' (${existing.sqlType} → ${desired.sqlType}) — provide evolve.coercions.${name}`,
        });
      }
    }
  }

  // Nullability changes
  for (const [name, desired] of desiredFields) {
    const existing = snapshotFields.get(name);
    if (!existing) continue;
    if (desired.sqlType !== existing.sqlType) continue;
    if (desired.required !== existing.required) {
      if (desired.required && !existing.required) {
        if (evolve?.backfills?.[name] !== undefined) {
          changes.push({
            entity: meta.entity, tier: 'cautious', kind: 'change-nullability', field: name,
            description: `Nullable → required on '${name}' in '${meta.entity}' (backfill provided)`,
            resolution: `evolve.backfills.${name}`,
          });
        } else {
          changes.push({
            entity: meta.entity, tier: 'cautious', kind: 'change-nullability', field: name,
            description: `Nullable → required on '${name}' in '${meta.entity}' — provide evolve.backfills.${name}`,
          });
        }
      } else {
        changes.push({
          entity: meta.entity, tier: 'safe', kind: 'change-nullability', field: name,
          description: `Required → nullable on '${name}' in '${meta.entity}'`,
        });
      }
    }
  }

  // Lifecycle state changes
  for (const [name, desired] of desiredFields) {
    const existing = snapshotFields.get(name);
    if (!existing) continue;
    if (desired.kind !== 'lifecycle' || existing.kind !== 'lifecycle') continue;

    const desiredStates = new Set(desired.lifecycleStates ?? []);
    const existingStates = new Set(existing.lifecycleStates ?? []);

    for (const state of desiredStates) {
      if (!existingStates.has(state)) {
        changes.push({
          entity: meta.entity, tier: 'safe', kind: 'add-lifecycle-state', field: name,
          description: `Add lifecycle state '${state}' to '${name}' on '${meta.entity}'`,
        });
      }
    }

    for (const state of existingStates) {
      if (!desiredStates.has(state)) {
        const stateMapping = evolve?.stateMap?.[name]?.[state];
        if (stateMapping) {
          changes.push({
            entity: meta.entity, tier: 'cautious', kind: 'remove-lifecycle-state', field: name,
            description: `Remove lifecycle state '${state}' from '${name}' on '${meta.entity}' — mapped to '${stateMapping}'`,
            resolution: `evolve.stateMap.${name}.${state}`,
          });
        } else {
          changes.push({
            entity: meta.entity, tier: 'ambiguous', kind: 'remove-lifecycle-state', field: name,
            description: `Lifecycle state '${state}' removed from '${name}' on '${meta.entity}' — provide evolve.stateMap.${name}.${state}`,
          });
        }
      }
    }
  }
}

// ── Error ───────────────────────────────────────────────────────

export class SchemaReconciliationError extends Error {
  readonly plan: ReconciliationPlan;
  constructor(plan: ReconciliationPlan) {
    const messages = [
      ...plan.ambiguous.map((c) => `  AMBIGUOUS: ${c.description}`),
      ...plan.destructive.filter((c) => !c.resolution).map((c) => `  DESTRUCTIVE: ${c.description}`),
      ...plan.cautious.filter((c) => !c.resolution).map((c) => `  CAUTIOUS: ${c.description}`),
    ];
    super(`Schema reconciliation blocked (${messages.length} unresolved changes):\n${messages.join('\n')}`);
    this.name = 'SchemaReconciliationError';
    this.plan = plan;
  }
}

// ── DDL execution ───────────────────────────────────────────────

interface ApplyContext {
  // biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
  readonly db: Kysely<any>;
  readonly change: SchemaChange;
  readonly meta?: AdapterMeta;
  readonly evolve?: EvolveConfig;
}

async function applyChange(ctx: ApplyContext): Promise<void> {
  const { db, change, meta, evolve } = ctx;
  const table = tableName(change.entity);

  switch (change.kind) {
    case 'add-column': {
      const snap = meta ? generateSnapshot(meta) : null;
      const field = snap?.fields.find((f) => f.name === change.field);
      const sqlType = field?.sqlType ?? 'TEXT';
      const backfillValue = evolve?.backfills?.[change.field!];

      if (field?.required && backfillValue !== undefined) {
        await sql`ALTER TABLE ${sql.ref(table)} ADD COLUMN ${sql.ref(change.field!)} ${sql.raw(sqlType)} DEFAULT ${sql.lit(backfillValue)}`.execute(db);
        await sql`UPDATE ${sql.ref(table)} SET ${sql.ref(change.field!)} = ${sql.lit(backfillValue)} WHERE ${sql.ref(change.field!)} IS NULL`.execute(db);
      } else {
        await sql`ALTER TABLE ${sql.ref(table)} ADD COLUMN ${sql.ref(change.field!)} ${sql.raw(sqlType)}`.execute(db);
      }
      break;
    }

    case 'rename-column': {
      if (!evolve?.renames) break;
      const oldName = Object.entries(evolve.renames).find(([, v]) => v === change.field)?.[0];
      if (!oldName) break;
      await sql`ALTER TABLE ${sql.ref(table)} RENAME COLUMN ${sql.ref(oldName)} TO ${sql.ref(change.field!)}`.execute(db);
      break;
    }

    case 'remove-column': {
      await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN ${sql.ref(change.field!)}`.execute(db);
      break;
    }

    case 'change-type': {
      const coercionFn = evolve?.coercions?.[change.field!];
      if (!coercionFn) break;
      const rows = await sql`SELECT ${sql.ref('id')}, ${sql.ref(change.field!)} FROM ${sql.ref(table)}`.execute(db);
      for (const row of rows.rows as Record<string, unknown>[]) {
        const newValue = coercionFn(row[change.field!]);
        await sql`UPDATE ${sql.ref(table)} SET ${sql.ref(change.field!)} = ${sql.lit(newValue)} WHERE id = ${sql.lit(row.id)}`.execute(db);
      }
      break;
    }

    case 'change-nullability': {
      const backfillValue = evolve?.backfills?.[change.field!];
      if (backfillValue !== undefined) {
        await sql`UPDATE ${sql.ref(table)} SET ${sql.ref(change.field!)} = ${sql.lit(backfillValue)} WHERE ${sql.ref(change.field!)} IS NULL`.execute(db);
      }
      break;
    }

    case 'remove-lifecycle-state': {
      const field = change.field!;
      if (!evolve?.stateMap?.[field]) break;
      for (const [removedState, replacementState] of Object.entries(evolve.stateMap[field])) {
        await sql`UPDATE ${sql.ref(table)} SET ${sql.ref(field)} = ${sql.lit(replacementState)} WHERE ${sql.ref(field)} = ${sql.lit(removedState)}`.execute(db);
      }
      break;
    }

    case 'add-entity':
    case 'remove-entity':
    case 'add-lifecycle-state':
      // No DDL: table creation handled by initialize(), entity removal handled by snapshot delete,
      // lifecycle states are TEXT values (no CHECK constraints).
      break;
  }
}

// ── Shared apply + snapshot logic ──────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
async function executeChangesAndUpdateSnapshots(
  db: Kysely<any>,
  plan: ReconciliationPlan,
  metas: readonly AdapterMeta[],
  snapshotStore: SchemaSnapshotStore,
  drops?: ReadonlySet<string>,
): Promise<ReconciliationReport> {
  if (!plan.canAutoApply) {
    throw new SchemaReconciliationError(plan);
  }

  const metaMap = new Map(metas.map((m) => [m.entity, m]));
  const applied: SchemaChange[] = [];

  for (const change of plan.changes) {
    const meta = metaMap.get(change.entity);
    await applyChange({ db, change, meta, evolve: meta?.evolve });
    applied.push(change);
  }

  for (const meta of metas) {
    await snapshotStore.writeSnapshot(generateSnapshot(meta));
  }

  if (drops) {
    for (const entity of drops) {
      await snapshotStore.deleteSnapshot(entity);
    }
  }

  return { applied, timestamp: new Date().toISOString() };
}

// ── Reconciliation pipeline ─────────────────────────────────────

/**
 * Build evolve config map from adapter metadata.
 */
function buildEvolveConfigs(metas: readonly AdapterMeta[]): Map<string, EvolveConfig> {
  const configs = new Map<string, EvolveConfig>();
  for (const meta of metas) {
    if (meta.evolve) configs.set(meta.entity, meta.evolve);
  }
  return configs;
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
export async function reconcileSchema(
  db: Kysely<any>,
  metas: readonly AdapterMeta[],
  snapshotStore: SchemaSnapshotStore,
  drops?: ReadonlySet<string>,
): Promise<ReconciliationReport> {
  const snapshots = await snapshotStore.readAllSnapshots();
  const plan = classifyChanges(metas, snapshots, buildEvolveConfigs(metas), drops ?? new Set());
  return executeChangesAndUpdateSnapshots(db, plan, metas, snapshotStore, drops);
}

// ── Production workflow ─────────────────────────────────────────

/**
 * Plan reconciliation without executing DDL. Returns the full plan
 * for review before calling applyReconciliation().
 */
// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
export async function planReconciliation(
  db: Kysely<any>,
  metas: readonly AdapterMeta[],
  snapshotStore: SchemaSnapshotStore,
  drops?: ReadonlySet<string>,
): Promise<ReconciliationPlan> {
  const snapshots = await snapshotStore.readAllSnapshots();
  return classifyChanges(metas, snapshots, buildEvolveConfigs(metas), drops ?? new Set());
}

/**
 * Apply a previously planned reconciliation. Use after planReconciliation()
 * when you want to review before executing.
 */
// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
export async function applyReconciliation(
  db: Kysely<any>,
  plan: ReconciliationPlan,
  metas: readonly AdapterMeta[],
  snapshotStore: SchemaSnapshotStore,
  drops?: ReadonlySet<string>,
): Promise<ReconciliationReport> {
  return executeChangesAndUpdateSnapshots(db, plan, metas, snapshotStore, drops);
}
