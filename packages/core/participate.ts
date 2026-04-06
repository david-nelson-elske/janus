/**
 * participate() — Pipeline wiring.
 *
 * Produces ParticipationRecords with implicit defaults and optional concern overrides.
 * Inline actions register handlers in the runtime registry as a side effect.
 *
 * STABLE — participate() is the consumer API for pipeline wiring. The function signature,
 * default handler set, and operation filtering logic are permanent. The records produced
 * here become rows in the participation entity at runtime.
 *
 * UPDATE @ M4 (Audit): When ownership scoping (ADR 01b) is implemented, validate concern
 * may need to know about owned: true on DefineConfig to enforce ownership field checks.
 */

import type {
  AuditConfig,
  DefineResult,
  Operation,
  ParticipateConfig,
  ParticipateResult,
  ParticipationRecord,
} from './types';
import { WRITE_OPERATIONS, resolveEntityName } from './types';

// Parse, validate, and invariant apply to create+update (not delete — deletes don't have input to check)
const PARSE_VALIDATE_OPS: readonly Operation[] = Object.freeze(['create', 'update']);
import { handler as registerHandler } from './handler-registry';

// ── Helpers ─────────────────────────────────────────────────────

function resolveOperations(entity: string | DefineResult): readonly Operation[] | undefined {
  if (typeof entity === 'string') return undefined;
  return entity.record.operations;
}

function record(
  source: string,
  handler: string,
  order: number,
  transactional: boolean,
  config: Record<string, unknown> | object = {},
  operations?: readonly Operation[],
): ParticipationRecord {
  return Object.freeze({
    source,
    handler,
    order,
    transactional,
    config: Object.freeze({ ...config }),
    operations: operations ? Object.freeze([...operations]) : undefined,
  });
}

/**
 * Returns the overlap of filterOps with entityOps.
 * If entityOps is unknown (string input), returns filterOps unchanged.
 * If overlap is empty, returns empty array (not undefined) so callers can skip.
 */
function operationOverlap(
  filterOps: readonly Operation[] | undefined,
  entityOps: readonly Operation[] | undefined,
): readonly Operation[] | undefined {
  if (!filterOps) return undefined;
  if (!entityOps) return filterOps;
  const set = new Set(entityOps);
  return filterOps.filter((op) => set.has(op));
}

// ── participate() ───────────────────────────────────────────────

export function participate(
  entity: string | DefineResult,
  config: ParticipateConfig = {},
): ParticipateResult {
  const entityName = resolveEntityName(entity);
  const entityOps = resolveOperations(entity);
  const records: ParticipationRecord[] = [];

  // ── Implicit defaults ───────────────────────────────────────

  // Parse (order=20, non-tx, create+update only — deletes don't need input parsing)
  if (config.parse !== false) {
    const ops = operationOverlap(PARSE_VALIDATE_OPS, entityOps);
    if (!ops || ops.length > 0) {
      records.push(record(entityName, 'schema-parse', 20, false, {}, ops));
    }
  }

  // Validate (order=25, non-tx, create+update only)
  if (config.validate !== false) {
    const ops = operationOverlap(PARSE_VALIDATE_OPS, entityOps);
    if (!ops || ops.length > 0) {
      records.push(record(entityName, 'schema-validate', 25, false, {}, ops));
    }
  }

  // Credential generation (order=30, non-tx, create only — auto-generates Token/QrCode values)
  {
    const ops = operationOverlap(['create'] as Operation[], entityOps);
    if (!ops || ops.length > 0) {
      records.push(record(entityName, 'credential-generate', 30, false, {}, ops));
    }
  }

  // CRUD handlers (order=35)
  if (entityOps) {
    for (const op of entityOps) {
      const handlerKey = `store-${op}`;
      const isTx = op !== 'read';
      records.push(record(entityName, handlerKey, 35, isTx, {}, [op]));
    }
  } else {
    // No entity info — generate all four
    records.push(record(entityName, 'store-read', 35, false, {}, ['read']));
    records.push(record(entityName, 'store-create', 35, true, {}, ['create']));
    records.push(record(entityName, 'store-update', 35, true, {}, ['update']));
    records.push(record(entityName, 'store-delete', 35, true, {}, ['delete']));
  }

  // Emit (order=40, transactional, write operations only)
  if (config.emit !== false) {
    const ops = operationOverlap(WRITE_OPERATIONS as Operation[], entityOps);
    if (!ops || ops.length > 0) {
      records.push(record(entityName, 'emit-broker', 40, true, {}, ops));
    }
  }

  // Respond (order=70, non-tx, all operations)
  if (config.respond !== false) {
    records.push(record(entityName, 'respond-shaper', 70, false));
  }

  // ── Optional concerns ─────────────────────────────────────────

  // Policy (order=10)
  if (config.policy) {
    records.push(record(entityName, 'policy-lookup', 10, false, config.policy));
  }

  // Rate limit (order=11)
  if (config.rateLimit) {
    records.push(record(entityName, 'rate-limit-check', 11, false, config.rateLimit));
  }

  // Invariant (order=26, create+update — predicates check proposed state)
  if (config.invariant && config.invariant.length > 0) {
    const ops = operationOverlap(PARSE_VALIDATE_OPS, entityOps);
    if (!ops || ops.length > 0) {
      records.push(
        record(entityName, 'invariant-check', 26, false, { predicates: config.invariant }, ops),
      );
    }
  }

  // Audit (order=50, transactional)
  // Short form: audit: AuditFull → writes only
  // Expanded form: audit: { level: AuditFull, operations: '*' } → all operations
  if (config.audit) {
    const isExpanded = typeof config.audit === 'object' && 'level' in config.audit;
    const auditConfig: AuditConfig = isExpanded
      ? (config.audit as AuditConfig)
      : { level: config.audit };

    const auditOps = auditConfig.operations === '*'
      ? undefined // all operations
      : operationOverlap(auditConfig.operations ?? (WRITE_OPERATIONS as Operation[]), entityOps);

    if (!auditOps || auditOps.length > 0) {
      records.push(
        record(entityName, 'audit-relational', 50, true, { level: auditConfig.level }, auditOps),
      );
    }
  }

  // Observe (order=50, non-tx, specified operations)
  if (config.observe) {
    records.push(
      record(entityName, 'observe-memory', 50, false, config.observe),
    );
  }

  // ── Inline actions ──────────────────────────────────────────

  if (config.actions) {
    for (const [actionName, actionConfig] of Object.entries(config.actions)) {
      const handlerKey = `${entityName}:${actionName}`;
      const kind = actionConfig.kind;
      const isTx = kind === 'mutation';

      // Side effect: register handler in runtime registry
      registerHandler(handlerKey, actionConfig.handler, actionConfig.description ?? `Action: ${entityName}:${actionName}`);

      records.push(
        record(
          entityName,
          handlerKey,
          35,
          isTx,
          {
            kind,
            actionName,
            scoped: actionConfig.scoped,
            inputSchema: actionConfig.inputSchema,
          },
          [], // Empty operations — excluded from standard pipelines; compile builds action pipelines separately
        ),
      );
    }
  }

  return Object.freeze({
    kind: 'participate' as const,
    records: Object.freeze(records),
  });
}
