/**
 * scope-enforce (Phase 1 runtime-strict).
 *
 * New contract (per balcony-solar Phase 1, user decision 1 — blast radius
 * verified zero across sibling workspace members):
 *   - Caller passes `input.scope` on every app.store.*() call, OR
 *   - Caller passes `input.scope: 'system'` from a CI-allowlisted file
 *     (.ci/scope-system-allowlist.txt), OR
 *   - Dispatch uses the internal SYSTEM identity (boot-time only).
 * Missing scope on a non-SYSTEM identity throws `auth-error`.
 *
 * New `StoreScope` (caller-scope) branches added:
 *   - email_webhook principal gate + op allowlist (D-14..16)
 *   - 'system' sentinel bypass (D-05)
 *   - federal / regional / municipal tier hierarchy walk (D-02, D-09..D-12)
 *   - plural campaignIds variant (D-04)
 *   - junction subquery injection for contact / organization (D-17..22)
 *   - runtime-strict throw when scope is absent on a non-SYSTEM identity
 *     (user decision 1; CI grep check in Plan 09 is the belt-and-suspenders gate)
 *
 * Entity-level ScopeConfig tier branches (system/province/mixed) are preserved
 * for type compatibility but are secondary — the caller-scope branch is the
 * primary authorisation input. When a caller passes a StoreScope, scope-enforce
 * uses it and skips the entity-level branches.
 *
 * See:
 *   - balcony-solar/.planning/phases/01-scope-foundation-production-guardrails/01-RESEARCH.md
 *       §Scope Shape + Hierarchy Walk, §email_webhook Principal, §Geo Model Refactor Order
 *   - balcony-solar/.planning/phases/01-scope-foundation-production-guardrails/01-CONTEXT.md
 *       D-01..D-22 + user decision 1 (blast radius zero)
 *
 * --- Legacy contract (still in effect for non-balcony consumers) ---
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
 * Order=12 (after policy-lookup=10 and rate-limit=11, before parse=20).
 */

import type { ExecutionHandler, EntityRecord, ScopeConfig, StoreScope, Identity } from '@janus/core';
import { isReadPage } from '@janus/core';

const DEFAULT_BYPASS_ROLES = ['sysadmin', 'system'] as const;

/**
 * email_webhook principal op allowlist (D-15). Every other op is denied.
 * Read as `${entity}.${operation}`.
 */
const EMAIL_WEBHOOK_ALLOWED_OPS: ReadonlySet<string> = new Set([
  'outreach.update',         // status + reply_received_at
  'contact.read',            // lookup only
  'consent_record.create',   // STOP / unsubscribe
]);

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

/**
 * Attach an EXISTS subquery to the input `where` clause that restricts rows to
 * ones present in the given junction table for one of the caller's campaign ids.
 *
 * Used for `contact` + `organization` entities once the Phase 1 junction tables
 * land (D-17..22). The subquery references the junction's foreign-key column
 * (`contact_id` or `org_id`) and campaign-id column. Adapter support for
 * `$existsIn` must match — the filter is a structured directive, not raw SQL.
 */
function attachJunctionSubquery(
  input: Record<string, unknown>,
  junctionEntity: string,
  fkField: string,
  campaignIds: readonly string[],
): Record<string, unknown> {
  const where = { ...((input.where as Record<string, unknown> | undefined) ?? {}) };
  where.id = {
    $existsIn: {
      entity: junctionEntity,
      field: fkField,
      where: { campaign_id: { $in: campaignIds } },
    },
  };
  return { ...input, where };
}

/**
 * Apply a structured caller scope to this dispatch:
 *   - Federal tier: read-all across country, write-own (input.campaignId must match scope)
 *   - Regional tier: validate region assignment, inject country_slug + region_slug filters
 *   - Municipal tier: regional + locality_slug filter
 *   - Plural campaignIds: require principal covers every requested campaign
 *
 * Mutates `ctx.parsed` (the supported channel for pre-store concerns to alter
 * the read shape). On write ops, throws `auth-error` when the input conflicts
 * with the caller scope.
 *
 * Junction subquery injection for `contact` / `organization` is applied on read
 * when the junction entity is registered (D-17..22).
 */
function enforceStructuredScope(
  callerScope: Exclude<StoreScope, 'system'>,
  identity: Identity,
  entityName: string,
  operation: string,
  input: Record<string, unknown>,
  ctx: Parameters<ExecutionHandler>[0],
): void {
  const assignments = identity.assignments ?? [];

  // ── plural campaignIds variant (D-04) ─────────────────────────
  if ('campaignIds' in callerScope) {
    const allowedCampaignIds = new Set(
      assignments.map((a) => a.campaignId ?? a.scope).filter((x): x is string => typeof x === 'string'),
    );
    for (const cid of callerScope.campaignIds) {
      if (!allowedCampaignIds.has(cid)) {
        denied(
          `Access denied: caller scope includes campaignId '${cid}' which is not in the principal's assignments`,
        );
      }
    }

    if (operation === 'read') {
      let nextInput: Record<string, unknown> = {
        ...input,
        where: { ...((input.where as Record<string, unknown> | undefined) ?? {}), country_slug: callerScope.country },
      };
      if (entityName === 'contact' || entityName === 'organization') {
        const junctionEntity = entityName === 'contact'
          ? 'contact_campaign_assignment'
          : 'organization_campaign_assignment';
        const fkField = entityName === 'contact' ? 'contact_id' : 'org_id';
        if (ctx.registry.entity(junctionEntity)) {
          nextInput = attachJunctionSubquery(nextInput, junctionEntity, fkField, callerScope.campaignIds);
        } else {
          denied(
            `junction entity '${junctionEntity}' not registered yet; ${entityName} scope-enforce requires it`,
          );
        }
      }
      ctx.parsed = nextInput;
      return;
    }

    // Plural scope is read-only (federal-peer union reads) — any write must
    // specify a single campaign id via the structured variant.
    denied(
      `Access denied: plural campaignIds scope is read-only; use the single-campaign StoreScope variant for writes`,
    );
  }

  // ── federal tier (D-12): read-all-across-country, write-own-only ──
  if (callerScope.tier === 'federal') {
    // Principal must be assigned to this federal campaign
    const allowedCampaignIds = new Set(
      assignments.map((a) => a.campaignId ?? a.scope).filter((x): x is string => typeof x === 'string'),
    );
    if (!allowedCampaignIds.has(callerScope.campaignId)) {
      denied(
        `Access denied: caller scope campaignId '${callerScope.campaignId}' is not in the principal's assignments`,
      );
    }

    if (operation === 'read') {
      let nextInput: Record<string, unknown> = {
        ...input,
        where: { ...((input.where as Record<string, unknown> | undefined) ?? {}), country_slug: callerScope.country },
      };
      if (entityName === 'contact' || entityName === 'organization') {
        const junctionEntity = entityName === 'contact'
          ? 'contact_campaign_assignment'
          : 'organization_campaign_assignment';
        const fkField = entityName === 'contact' ? 'contact_id' : 'org_id';
        if (ctx.registry.entity(junctionEntity)) {
          nextInput = attachJunctionSubquery(nextInput, junctionEntity, fkField, [callerScope.campaignId]);
        } else {
          denied(
            `junction entity '${junctionEntity}' not registered yet; ${entityName} scope-enforce requires it`,
          );
        }
      }
      ctx.parsed = nextInput;
      return;
    }

    // Write: require input's campaignId / campaign_id to equal scope.campaignId
    const inputCampaign = (input.campaignId ?? input.campaign_id) as string | undefined;
    if (inputCampaign !== undefined && inputCampaign !== callerScope.campaignId) {
      denied(
        `Access denied: federal tier may only write its own campaign's rows; input carries campaign '${inputCampaign}' but scope is '${callerScope.campaignId}'`,
      );
    }
    return;
  }

  // ── regional tier (D-09..D-12): validate region, filter by country + region ──
  if (callerScope.tier === 'regional') {
    if (!callerScope.region) {
      denied(`Access denied: regional tier requires a region in the caller scope`);
    }
    // Principal must be assigned to this region (or carry matching assignment)
    const allowedRegions = new Set(
      assignments.map((a) => a.region ?? a.scope).filter((x): x is string => typeof x === 'string'),
    );
    const allowedCampaignIds = new Set(
      assignments.map((a) => a.campaignId ?? a.scope).filter((x): x is string => typeof x === 'string'),
    );
    if (!allowedRegions.has(callerScope.region) && !allowedCampaignIds.has(callerScope.campaignId)) {
      denied(
        `Access denied: caller scope region '${callerScope.region}' / campaignId '${callerScope.campaignId}' is not in the principal's assignments`,
      );
    }

    if (operation === 'read') {
      // Hierarchy walk: include the region AND country-scoped-null rows (D-12).
      let nextInput: Record<string, unknown> = {
        ...input,
        where: {
          ...((input.where as Record<string, unknown> | undefined) ?? {}),
          country_slug: callerScope.country,
          region_slug: { $in: [callerScope.region, null] },
        },
      };
      if (entityName === 'contact' || entityName === 'organization') {
        const junctionEntity = entityName === 'contact'
          ? 'contact_campaign_assignment'
          : 'organization_campaign_assignment';
        const fkField = entityName === 'contact' ? 'contact_id' : 'org_id';
        if (ctx.registry.entity(junctionEntity)) {
          nextInput = attachJunctionSubquery(nextInput, junctionEntity, fkField, [callerScope.campaignId]);
        } else {
          denied(
            `junction entity '${junctionEntity}' not registered yet; ${entityName} scope-enforce requires it`,
          );
        }
      }
      ctx.parsed = nextInput;
      return;
    }

    // Write: require input's region_slug matches scope.region (or is null for
    // country-scoped entities — regional leads may write country-null rows only
    // if the scope allows; we allow null here per D-12's hierarchy walk).
    const inputRegion = input.region_slug as string | null | undefined;
    if (inputRegion !== undefined && inputRegion !== null && inputRegion !== callerScope.region) {
      denied(
        `Access denied: regional tier write carries region_slug '${inputRegion}' but scope is '${callerScope.region}'`,
      );
    }
    return;
  }

  // ── municipal tier (D-09..D-12): regional + locality_slug ──
  if (callerScope.tier === 'municipal') {
    if (!callerScope.region || !callerScope.locality) {
      denied(`Access denied: municipal tier requires both region and locality in the caller scope`);
    }
    const allowedCampaignIds = new Set(
      assignments.map((a) => a.campaignId ?? a.scope).filter((x): x is string => typeof x === 'string'),
    );
    if (!allowedCampaignIds.has(callerScope.campaignId)) {
      denied(
        `Access denied: caller scope campaignId '${callerScope.campaignId}' is not in the principal's assignments`,
      );
    }

    if (operation === 'read') {
      let nextInput: Record<string, unknown> = {
        ...input,
        where: {
          ...((input.where as Record<string, unknown> | undefined) ?? {}),
          country_slug: callerScope.country,
          region_slug: { $in: [callerScope.region, null] },
          locality_slug: { $in: [callerScope.locality, null] },
        },
      };
      if (entityName === 'contact' || entityName === 'organization') {
        const junctionEntity = entityName === 'contact'
          ? 'contact_campaign_assignment'
          : 'organization_campaign_assignment';
        const fkField = entityName === 'contact' ? 'contact_id' : 'org_id';
        if (ctx.registry.entity(junctionEntity)) {
          nextInput = attachJunctionSubquery(nextInput, junctionEntity, fkField, [callerScope.campaignId]);
        } else {
          denied(
            `junction entity '${junctionEntity}' not registered yet; ${entityName} scope-enforce requires it`,
          );
        }
      }
      ctx.parsed = nextInput;
      return;
    }

    // Write: input.locality_slug must match (or be null)
    const inputLocality = input.locality_slug as string | null | undefined;
    if (inputLocality !== undefined && inputLocality !== null && inputLocality !== callerScope.locality) {
      denied(
        `Access denied: municipal tier write carries locality_slug '${inputLocality}' but scope is '${callerScope.locality}'`,
      );
    }
    const inputRegion = input.region_slug as string | null | undefined;
    if (inputRegion !== undefined && inputRegion !== null && inputRegion !== callerScope.region) {
      denied(
        `Access denied: municipal tier write carries region_slug '${inputRegion}' but scope is '${callerScope.region}'`,
      );
    }
    return;
  }

  // Unrecognised tier — fail closed.
  denied(`Access denied: unrecognised caller scope tier`);
}

export const scopeEnforce: ExecutionHandler = async (ctx) => {
  const entity = ctx.registry.entity(ctx.entity);
  const identity = ctx.identity;
  const operation = ctx.operation;
  const input = (ctx.input ?? {}) as Record<string, unknown>;

  // ── email_webhook principal gate (D-14..16) ─────────────────
  // Runs BEFORE any other tier / caller-scope logic so a malformed
  // email_webhook principal cannot bypass via a structured tier scope.
  if (identity.roles?.includes('email_webhook')) {
    const opKey = `${ctx.entity}.${operation}`;
    if (!EMAIL_WEBHOOK_ALLOWED_OPS.has(opKey)) {
      denied(
        `Access denied: email_webhook principal cannot ${operation} on '${ctx.entity}' (allowed: ${[...EMAIL_WEBHOOK_ALLOWED_OPS].join(', ')})`,
      );
    }
    // Fall through — email_webhook is bounded by its assignment's campaignId,
    // which the remaining scope branches enforce like any other principal.
  }

  // ── caller-scope branch (Phase 1, runtime-strict per user decision 1) ──
  const callerScope = input.scope as StoreScope | undefined;

  if (callerScope === 'system') {
    // 'system' sentinel — runtime trust. The CI grep check (Plan 09) and the
    // .ci/scope-system-allowlist.txt gate *which* files are permitted to pass
    // 'system' at source; this runtime accepts the sentinel unconditionally.
    return;
  }

  if (callerScope && typeof callerScope === 'object') {
    enforceStructuredScope(callerScope, identity, ctx.entity, operation, input, ctx);
    return;
  }

  // callerScope is undefined — runtime-strict missing-scope branch.
  // Internal SYSTEM identity (dispatch.ts default) is permitted; every other
  // identity must pass scope explicitly.
  const isSystemIdentity = !!identity?.roles?.includes('system');
  if (!isSystemIdentity) {
    // Fall through to entity-level ScopeConfig ONLY if the entity is scoped
    // AND the identity has assignments — this preserves legacy behavior for
    // sibling consumers (blast radius zero; they don't wire scope-enforce
    // today, but keep the branch for type compatibility).
    if (!entity?.scope) {
      denied(
        `scope argument required — non-allowlisted call sites MUST pass scope: StoreScope or scope: "system" (from an allowlisted file). entity='${ctx.entity}', op='${operation}'`,
      );
    }
    // Entity is scoped AND caller omitted StoreScope AND identity isn't SYSTEM.
    // Runtime-strict: throw. Legacy assignments-based branches below only
    // run under the SYSTEM identity path.
    denied(
      `scope argument required — non-allowlisted call sites MUST pass scope: StoreScope or scope: "system" (from an allowlisted file). entity='${ctx.entity}', op='${operation}'`,
    );
  }

  // ── SYSTEM identity fall-through: defer to entity-level ScopeConfig ──
  // This path is only reached for the internal SYSTEM identity (boot-time,
  // internal dispatches). The entity-level branches below are unchanged from
  // the pre-Phase-1 behaviour and preserved for compatibility.
  if (!entity?.scope) return; // entity not scoped — nothing to do

  const scope = entity.scope;

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
