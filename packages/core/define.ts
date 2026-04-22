/**
 * define() — Entity definition.
 *
 * Pure function that returns a frozen DefineResult.
 * No side effects, no global registration.
 *
 * STABLE — define() is the consumer API for entity identity (schema + storage).
 * The function signature, return type, and all internal logic (schema scanning,
 * operation derivation, transition targets) are permanent. These produce the
 * GraphNodeRecords that become rows in the graph_node entity at runtime.
 */

import { isLifecycle, isWiringType, isSemanticField, Private, DateTime } from '@janus/vocabulary';
import type { ClassifiedSchema, Sensitivity, StorageStrategy, TokenHints } from '@janus/vocabulary';

import type {
  DefineConfig,
  DefineResult,
  GraphNodeRecord,
  IndexConfig,
  LifecycleEntry,
  Operation,
  SchemaField,
  TransitionTarget,
  WiringFieldEntry,
} from './types';
import { ENTITY_NAME, FIELD_NAME, MAX_ENTITY_NAME_LENGTH } from './types';

// ── Validation ──────────────────────────────────────────────────

/** Framework-managed columns that consumers cannot declare in their schema. */
const RESERVED_FIELDS = new Set([
  'id', '_version', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', '_deletedAt',
]);

function validateSchema(schema: Record<string, unknown>): void {
  for (const field of Object.keys(schema)) {
    if (RESERVED_FIELDS.has(field)) {
      throw new Error(
        `Reserved field name '${field}' cannot be used in entity schema. ` +
        `Framework-managed fields: ${[...RESERVED_FIELDS].join(', ')}`,
      );
    }
    if (!FIELD_NAME.test(field)) {
      throw new Error(
        `Invalid field name '${field}': must match ${FIELD_NAME} (lowercase alphanumeric + underscores)`,
      );
    }
  }
}

function validateEntityName(name: string): void {
  if (!name) {
    throw new Error('Entity name must not be empty');
  }
  if (name.length > MAX_ENTITY_NAME_LENGTH) {
    throw new Error(`Entity name must be at most ${MAX_ENTITY_NAME_LENGTH} characters, got ${name.length}`);
  }
  if (!ENTITY_NAME.test(name)) {
    throw new Error(
      `Invalid entity name '${name}': must match ${ENTITY_NAME} (lowercase alphanumeric + underscores)`,
    );
  }
}

// ── Schema scanning ─────────────────────────────────────────────

function isClassifiedSchema(value: unknown): value is ClassifiedSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    'classification' in value &&
    'schema' in value
  );
}

function scanSchema(schema: Record<string, SchemaField>): {
  lifecycles: LifecycleEntry[];
  wiringFields: WiringFieldEntry[];
} {
  const lifecycles: LifecycleEntry[] = [];
  const wiringFields: WiringFieldEntry[] = [];

  for (const [field, fieldDef] of Object.entries(schema)) {
    if (isLifecycle(fieldDef)) {
      lifecycles.push({ field, lifecycle: fieldDef });
    } else if (isWiringType(fieldDef)) {
      wiringFields.push({ field, wiring: fieldDef });
    }
  }

  return { lifecycles, wiringFields };
}

// ── Transition target derivation ────────────────────────────────

function deriveTransitionTargets(lifecycles: readonly LifecycleEntry[]): TransitionTarget[] {
  const targets: TransitionTarget[] = [];
  const seenByField = new Map<string, Set<string>>(); // field → set of target names
  const globalNames = new Map<string, string>(); // target name → owning field

  for (const { field, lifecycle } of lifecycles) {
    if (!seenByField.has(field)) seenByField.set(field, new Set());
    const fieldSeen = seenByField.get(field)!;

    for (const [from, toStates] of Object.entries(lifecycle.transitions)) {
      for (const to of toStates) {
        // Check cross-field conflicts
        const owner = globalNames.get(to);
        if (owner !== undefined && owner !== field) {
          throw new Error(
            `Duplicate transition target name '${to}' across lifecycle fields '${owner}' and '${field}'. ` +
            `Each transition target must be unique within an entity.`,
          );
        }
        globalNames.set(to, field);

        // Only add target once per (field, to) pair — same target reachable from multiple states
        if (!fieldSeen.has(to)) {
          fieldSeen.add(to);
          targets.push({ field, from, to, name: to });
        }
      }
    }
  }

  return targets;
}

// ── Sensitivity derivation ──────────────────────────────────────

function deriveSensitivity(classification: ClassifiedSchema): Sensitivity {
  switch (classification.classification.kind) {
    case 'public':
      return 'open';
    case 'private':
      return 'standard';
    case 'sensitive':
      return 'restricted';
  }
}

// ── Operation derivation ────────────────────────────────────────

/**
 * STABLE — operation set per storage strategy is an ADR-124 invariant.
 * Virtual entities may gain write operations via custom actions (ADR 01),
 * but the base operation set from storage is fixed.
 */
export function deriveOperations(storage: StorageStrategy): readonly Operation[] {
  switch (storage.mode) {
    case 'persistent':
    case 'volatile':
      return Object.freeze(['read', 'create', 'update', 'delete'] as const);
    case 'singleton':
      return Object.freeze(['read', 'update'] as const);
    case 'derived':
    case 'virtual':
      return Object.freeze(['read'] as const);
    default:
      return Object.freeze(['read'] as const);
  }
}

// ── Deep freeze ─────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;

  Object.freeze(obj);

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj;
}

// ── define() ────────────────────────────────────────────────────

export function define(name: string, config: DefineConfig): DefineResult {
  validateEntityName(name);

  // Resolve classified schema
  let classifiedSchema: ClassifiedSchema = isClassifiedSchema(config.schema)
    ? config.schema
    : Private(config.schema as Record<string, unknown>);

  let schema = classifiedSchema.schema as Record<string, SchemaField>;

  // Inject companion fields for Token expiry (before validation/scanning)
  {
    const companions: Record<string, SchemaField> = {};
    for (const [field, fieldDef] of Object.entries(schema)) {
      if (!isSemanticField(fieldDef) || fieldDef.kind !== 'token') continue;
      const hints = fieldDef.hints as TokenHints;
      if (!hints.expires) continue;
      const companionField = `_${field}ExpiresAt`;
      if (!(companionField in schema)) {
        companions[companionField] = DateTime();
      }
    }
    if (Object.keys(companions).length > 0) {
      schema = { ...schema, ...companions };
      classifiedSchema = Object.freeze({
        classification: classifiedSchema.classification,
        schema: Object.freeze(schema),
      }) as ClassifiedSchema;
    }
  }

  // Validate no reserved field names
  validateSchema(schema);

  // Scan schema for lifecycles and wiring fields
  const { lifecycles, wiringFields } = scanSchema(schema);

  // Derive transition targets
  const transitionTargets = deriveTransitionTargets(lifecycles);

  // Derive operations from storage
  const operations = deriveOperations(config.storage);

  // Derive sensitivity from classification
  const sensitivity = deriveSensitivity(classifiedSchema);

  // Validate scope config if present: 'province' and 'mixed' tiers require a
  // field that exists in the entity schema.
  if (config.scope) {
    if (config.scope.tier === 'province' || config.scope.tier === 'mixed') {
      if (!config.scope.field) {
        throw new Error(`Entity '${name}' scope.tier='${config.scope.tier}' requires a 'field'`);
      }
      if (!(config.scope.field in schema)) {
        throw new Error(
          `Entity '${name}' scope.field='${config.scope.field}' is not declared in the schema`,
        );
      }
    }
  }

  const record: GraphNodeRecord = {
    name,
    origin: config.origin ?? 'consumer',
    schema,
    classifiedSchema,
    storage: config.storage,
    description: config.description,
    owned: config.owned,
    scope: config.scope,
    sensitivity,
    lifecycles,
    wiringFields,
    operations,
    transitionTargets,
    indexes: config.indexes,
    evolve: config.evolve,
    // naturalKey — propagated through to GraphNodeRecord so consumers
    // (e.g. balcony-solar's seed upsert helper) can read it via
    // app.registry.entity(name).naturalKey. Additive (D-26).
    naturalKey: config.naturalKey,
  };

  return deepFreeze({ kind: 'define' as const, record });
}
