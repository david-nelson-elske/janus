/**
 * scope-enforce — Tier/region scoping via identity assignments (ADR 01e).
 *
 * Reads the entity's `scope` config (declared in define()) and the identity's
 * `assignments` (a list of scope values like region ids the identity can touch),
 * and enforces three tiers:
 *
 *   - 'system'   — entity-wide. Reads pass through; writes require a bypass role.
 *   - 'province' — every row's `field` must be in identity.assignments. Reads
 *                  inject `where[field] = $in(allowedScopes)`. Writes validate
 *                  the row's field value against assignments.
 *   - 'mixed'    — like 'province', but rows with field=NULL are system-tier
 *                  (visible to all, writable only by bypass roles). Reads use
 *                  `$inOrNull`.
 *
 * Bypass roles (default ['sysadmin', 'system']) skip all scope enforcement.
 *
 * This concern is generic — it doesn't know about app-specific role names like
 * 'lead' vs 'contributor'. Per-operation gating remains policy-lookup's job.
 *
 * Order=12 (after policy-lookup=10 and rate-limit=11, before parse=20).
 */

import type { ExecutionHandler, EntityRecord, ScopeConfig } from '@janus/core';
import { isReadPage } from '@janus/core';

const DEFAULT_BYPASS_ROLES = ['sysadmin', 'system'] as const;

function denied(message: string): never {
  throw Object.assign(new Error(message), {
    kind: 'auth-error',
    retryable: false,
  });
}

function isBypassed(identityRoles: readonly string[], scope: ScopeConfig): boolean {
  const bypass = scope.bypassRoles ?? DEFAULT_BYPASS_ROLES;
  for (const role of bypass) {
    if (identityRoles.includes(role)) return true;
  }
  return false;
}

function allowedScopes(identity: { assignments?: readonly { scope: string }[] }): string[] {
  return (identity.assignments ?? []).map((a) => a.scope);
}

export const scopeEnforce: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  if (!entity?.scope) return; // entity not scoped — nothing to do

  const scope = entity.scope;
  const identity = ctx.identity;
  const operation = ctx.operation;

  // Bypass roles skip everything
  if (isBypassed(identity.roles, scope)) return;

  // ── system tier ─────────────────────────────────────────────
  // Reads pass through. Writes require a bypass role.
  if (scope.tier === 'system') {
    if (operation === 'read') return;
    denied(
      `Access denied: ${operation} on system-tier entity '${ctx.entity}' requires a privileged role`,
    );
  }

  // ── province / mixed tier ───────────────────────────────────
  const field = scope.field;
  const allowed = allowedScopes(identity);
  const isMixed = scope.tier === 'mixed';

  // ── READ: inject where clause ──────────────────────────────
  if (operation === 'read') {
    const input = (ctx.input ?? {}) as Record<string, unknown>;

    // Single-record reads (by id) — let the read happen, then validate
    // post-read in store-handlers via the same logic. For now, fall through
    // to the where-injection branch only when there's no id; otherwise we
    // need to validate after the fact.
    if (input.id) {
      // Defer to a post-read hook by stashing required context. The simplest
      // safe approach is to read the row here and check it immediately.
      const existing = await ctx.store.read(ctx.entity, { id: input.id as string });
      if (!isReadPage(existing)) {
        const rec = existing as EntityRecord | null;
        if (rec) {
          const rowScope = rec[field as keyof EntityRecord] as string | null | undefined;
          if (rowScope == null) {
            if (!isMixed) {
              denied(`Access denied: '${ctx.entity}' ${input.id} has no scope`);
            }
            // mixed + null is visible to everyone; allow
          } else if (!allowed.includes(rowScope)) {
            denied(
              `Access denied: '${ctx.entity}' ${input.id} is scoped to '${rowScope}' which is not in your assignments`,
            );
          }
        }
      }
      return;
    }

    // List read — inject filter via ctx.parsed (input is immutable; store-read
    // prefers ctx.parsed when present, so this is the supported channel for
    // pre-store concerns to alter the read shape).
    const where = { ...((input.where as Record<string, unknown> | undefined) ?? {}) };
    if (allowed.length === 0 && !isMixed) {
      // No assignments and not mixed — deny by giving an impossible filter
      where[field] = { $in: [] };
    } else if (isMixed) {
      where[field] = { $inOrNull: allowed };
    } else {
      where[field] = { $in: allowed };
    }
    ctx.parsed = { ...input, where };
    return;
  }

  // ── CREATE: validate input.field is in assignments ─────────
  if (operation === 'create') {
    const input = (ctx.input ?? {}) as Record<string, unknown>;
    const value = input[field];

    if (value == null) {
      // Mixed tier + null = system-tier write — only bypass roles allowed
      // (we already checked bypass above and fell through, so deny)
      denied(
        `Access denied: cannot create '${ctx.entity}' with null '${field}' (system-tier rows require a privileged role)`,
      );
    }

    if (typeof value !== 'string' || !allowed.includes(value)) {
      denied(
        `Access denied: cannot create '${ctx.entity}' with ${field}='${String(value)}' — not in your assignments`,
      );
    }
    return;
  }

  // ── UPDATE / DELETE / DISPATCH (transition): validate existing row ─
  // Read the existing record and check its scope field. For updates that
  // *change* the scope field, also validate the new value.
  const input = (ctx.input ?? {}) as Record<string, unknown>;
  const id = input.id as string | undefined;
  if (!id) {
    // Other concerns will fail this with a clearer error; just return
    return;
  }

  const existing = await ctx.store.read(ctx.entity, { id });
  if (isReadPage(existing)) return; // shouldn't happen for an id read; let other concerns handle

  const rec = existing as EntityRecord | null;
  if (!rec) return; // not found — let store handler raise

  const currentScope = rec[field as keyof EntityRecord] as string | null | undefined;
  if (currentScope == null) {
    if (!isMixed) {
      denied(`Access denied: '${ctx.entity}' ${id} has no scope value`);
    }
    // mixed-tier system row — only bypass roles can mutate
    denied(
      `Access denied: '${ctx.entity}' ${id} is a system-tier row and requires a privileged role to modify`,
    );
  } else if (!allowed.includes(currentScope)) {
    denied(
      `Access denied: '${ctx.entity}' ${id} is scoped to '${currentScope}' which is not in your assignments`,
    );
  }

  // If the patch tries to move the row to a different scope, validate the new value
  if (operation === 'update' && field in input) {
    const newScope = input[field];
    if (newScope == null) {
      denied(
        `Access denied: cannot move '${ctx.entity}' ${id} to system-tier (null '${field}')`,
      );
    }
    if (typeof newScope !== 'string' || !allowed.includes(newScope)) {
      denied(
        `Access denied: cannot move '${ctx.entity}' ${id} to ${field}='${String(newScope)}' — not in your assignments`,
      );
    }
  }

  // For lifecycle dispatch (anything that's not read/create/update/delete), we've
  // already validated that the existing row is in scope, so allow it through.
};
