/**
 * schema-parse — Schema-driven input parsing and coercion.
 *
 * STABLE — parse logic is an ADR-05 invariant. Coerces input fields to match
 * semantic types, strips unknown fields, checks required fields on create.
 */

import { isSemanticField, isLifecycle, isWiringType } from '@janus/vocabulary';
import type { ExecutionHandler } from '@janus/core';

export const schemaParse: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  if (!entity) return;

  // Use ctx.parsed if already set by an upstream handler (e.g., http-receive),
  // otherwise fall back to ctx.input (direct dispatch path).
  const input = (ctx.parsed ?? ctx.input) as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') {
    ctx.parsed = {};
    return;
  }

  const parsed: Record<string, unknown> = {};
  const schema = entity.schema;

  for (const [field, fieldDef] of Object.entries(schema)) {
    if (!(field in input)) {
      // Check required on create
      if (
        ctx.operation === 'create' &&
        isSemanticField(fieldDef) &&
        fieldDef.hints?.required
      ) {
        throw Object.assign(new Error(`Required field '${field}' is missing`), {
          kind: 'parse-error',
          retryable: false,
        });
      }
      continue;
    }

    const value = input[field];

    // Coerce types
    if (isSemanticField(fieldDef)) {
      parsed[field] = coerceValue(value, fieldDef.kind);
    } else if (isLifecycle(fieldDef) || isWiringType(fieldDef)) {
      parsed[field] = value;
    }
  }

  // id is always passed through for update/delete
  if ('id' in input) {
    parsed.id = input.id;
  }

  ctx.parsed = parsed;
};

function coerceValue(value: unknown, kind: string): unknown {
  if (value === null || value === undefined) return value;

  switch (kind) {
    case 'int':
    case 'intCents':
    case 'intBps':
    case 'duration':
      return typeof value === 'string' ? Number.parseInt(value, 10) : value;
    case 'float':
      return typeof value === 'string' ? Number.parseFloat(value) : value;
    case 'bool':
      if (typeof value === 'string') return value === 'true' || value === '1';
      return value;
    default:
      return value;
  }
}
